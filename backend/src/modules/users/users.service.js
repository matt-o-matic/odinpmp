import bcrypt from 'bcryptjs';

import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { pendingEmailFor, requestEmailChange } from './email-change.js';
import { mergeProfilePreferences } from './profile-preferences.js';

function primaryMembership(user) {
  return user?.memberships?.[0] ?? null;
}

function parseAvatarSummary(dataUrl, userId, storageRootDir) {
  const text = String(dataUrl ?? '').trim();
  const summary = {
    avatarBytes: null,
    avatarDataUrlValid: false,
    avatarExt: null,
    avatarProvided: text.length > 0,
    avatarStorageRootDir: storageRootDir ?? null,
    avatarWriteTarget: null,
  };

  if (!text) {
    return summary;
  }

  const match = text.match(/^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i);
  if (!match) {
    return summary;
  }

  let ext = match[1].toLowerCase();
  if (ext === 'jpeg') {
    ext = 'jpg';
  }

  summary.avatarDataUrlValid = true;
  summary.avatarExt = ext;
  summary.avatarWriteTarget = userId ? `${userId}.${ext}` : null;

  try {
    summary.avatarBytes = Buffer.from(match[2], 'base64').length;
  } catch (_error) {
    summary.avatarBytes = null;
  }

  return summary;
}

function logUsersRepositoryFailure({ error, operation, user, extra = {}, requestContext = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, {
      ...requestContext,
      tenantId: primaryMembership(user)?.tenantId ?? requestContext.tenantId ?? null,
      userId: user?.id ?? requestContext.userId ?? null,
      ...extra,
    }),
    error,
    level: 'warn',
    message: 'Users repository operation failed.',
  });
}

export function requireAuthenticatedUser(user) {
  if (!user?.id) {
    throw new HttpError(401, 'Authentication required.');
  }

  return user;
}

function isBasicUser(user) {
  return user?.authMethod === 'basic';
}

function isValidTimezone(timeZone) {
  if (!timeZone) {
    return false;
  }

  try {
    // Throws if timeZone is invalid.
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch (_error) {
    return false;
  }
}

function validatePhone(phone) {
  if (!phone) {
    return true;
  }

  return /^[+\-()0-9\s]+$/.test(phone);
}

// `emailChange`: the dependencies of users/email-change.js. A profile's email changes only
// through its emailed link; the profile answers with the address still waiting for one.
export async function getUserProfileForUser(user, usersRepository, sessionsRepository, emailChange = {}) {
  requireAuthenticatedUser(user);
  const profile = await usersRepository.getProfile({ userId: user.id });

  if (!profile) {
    throw new HttpError(404, 'User not found.');
  }

  const sessions = await sessionsRepository.listActiveSessions({ userId: user.id });

  return {
    ok: true,
    pendingEmail: await pendingEmailFor(emailChange, user.id),
    user: profile,
    sessions,
  };
}

export async function updateUserProfileForUser(user, input, usersRepository, authRepository, requestContext = {}, emailChange = {}) {
  requireAuthenticatedUser(user);

  if (input.phone && !validatePhone(input.phone)) {
    throw new HttpError(400, 'Phone number contains invalid characters.');
  }

  if (!isValidTimezone(input.timezone)) {
    throw new HttpError(400, 'Invalid timezone selected.');
  }

  const stored = await authRepository.findUserById(user.id);
  if (!stored) {
    throw new HttpError(404, 'User not found.');
  }

  if (!isBasicUser(stored) && (input.currentPassword || input.newPassword || input.confirmNewPassword || input.base64Avatar)) {
    // Legacy only allowed local-auth users to change password or avatar here.
    // OAuth users can still update profile fields and preferences.
  }

  if (isBasicUser(stored)) {
    const wantsPasswordChange = Boolean(input.newPassword || input.confirmNewPassword);

    if (wantsPasswordChange) {
      if (!input.newPassword || !input.confirmNewPassword) {
        throw new HttpError(400, 'Both new password fields are required if changing password.');
      }

      if (input.newPassword.length < 8) {
        throw new HttpError(400, 'New password must be at least 8 characters long.');
      }

      if (!input.currentPassword) {
        throw new HttpError(400, 'Current password is required.');
      }

      const matches = await bcrypt.compare(input.currentPassword, stored.passwordHash ?? '');
      if (!matches) {
        throw new HttpError(400, 'Current password is incorrect.');
      }

      if (input.newPassword !== input.confirmNewPassword) {
        throw new HttpError(400, 'New passwords do not match.');
      }
    } else if (input.currentPassword) {
      // Legacy: if new password is blank, ignore currentPassword.
    }
  }

  const wantedEmail = String(input.email ?? '').trim().toLowerCase();
  if (wantedEmail && wantedEmail !== String(stored.email ?? '').trim().toLowerCase()) {
    const holder = await authRepository.findUserByEmail(wantedEmail);
    if (holder && holder.id !== stored.id) throw new HttpError(409, 'Another account already uses that email address.', { details: { code: 'email_in_use' } });
  }

  const membership = primaryMembership(stored);
  const tenantId = membership?.tenantId ?? null;
  const avatarSummary = parseAvatarSummary(
    input.base64Avatar,
    stored.id,
    usersRepository?.avatarStorageRootDir ?? null,
  );
  let updated;

  try {
    const current = await usersRepository.getProfile({ userId: stored.id });
    updated = await usersRepository.updateProfile({
      aboutMe: input.aboutMe,
      base64Avatar: input.base64Avatar,
      department: input.department,
      email: stored.email,
      firstName: input.firstName,
      lastName: input.lastName,
      newPassword: input.newPassword,
      phone: input.phone,
      preferences: mergeProfilePreferences(current?.preferences, input.preferences),
      profileDisplayName: input.profileDisplayName,
      tenantId,
      timezone: input.timezone,
      title: input.title,
      userId: stored.id,
    });
  } catch (error) {
    logUsersRepositoryFailure({
      error,
      extra: {
        ...avatarSummary,
        emailChanged: String(input.email ?? '').trim().toLowerCase() !== String(stored.email ?? '').trim().toLowerCase(),
        hasPasswordChange: Boolean(input.newPassword),
        profileDisplayName: input.profileDisplayName,
      },
      operation: 'users.updateProfile',
      requestContext,
      user: stored,
    });
    throw error;
  }

  // A new address is only asked for here; the account keeps its own until the link is opened.
  const pendingEmail = await requestEmailChange({ ...emailChange, authRepository }, { account: stored, newEmail: input.email })
    ?? await pendingEmailFor(emailChange, stored.id);

  return {
    ok: true,
    pendingEmail,
    user: updated,
  };
}

export async function killUserSessionForUser(user, tokenId, sessionsRepository, requestContext = {}) {
  requireAuthenticatedUser(user);
  let killed = false;

  try {
    killed = await sessionsRepository.killSession({ tokenId, userId: user.id });
  } catch (error) {
    logUsersRepositoryFailure({
      error,
      extra: {
        tokenId,
      },
      operation: 'users.killSession',
      requestContext,
      user,
    });
    throw error;
  }

  if (!killed) {
    throw new HttpError(404, 'Session not found or has already expired.');
  }

  return {
    ok: true,
  };
}
