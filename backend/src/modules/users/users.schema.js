import { z } from 'zod';
import { HOME_LENSES } from '../home/home-lenses.js';
import { MAX_AVATAR_DATA_URL_LENGTH } from './avatar-limits.js';

function trimString(max, fallback = '') {
  return z.preprocess(
    (value) => (value == null ? fallback : value),
    z.string().trim().max(max),
  );
}

function requiredString(max) {
  return z.string().trim().min(1).max(max);
}

function optionalEmail() {
  return z.preprocess(
    (value) => (value == null ? '' : value),
    z.string().trim().email().max(255),
  );
}

function optionalDataUrl() {
  return z.preprocess(
    (value) => (value == null ? '' : value),
    z.string().trim().max(MAX_AVATAR_DATA_URL_LENGTH),
  );
}

export const userPreferencesSchema = z.object({
  emailNotifTasks: z.boolean().optional(),
  emailNotifMentions: z.boolean().optional(),
  emailNotifSummaries: z.boolean().optional(),
  emailNotifTopicReplies: z.boolean().optional(),
  emailNotifChannelDigest: z.boolean().optional(),
  inAppNotifTaskDue: z.boolean().optional(),
  inAppNotifComments: z.boolean().optional(),
  // Set by the profile form that the notification senders honor (notification-preferences.js).
  notificationPrefsVersion: z.number().int().min(1).max(100).optional(),
  darkMode: z.boolean().optional(),
  // The Home view last chosen (modules/home). Home saves it through PUT /api/home/lens.
  homeLens: z.enum(HOME_LENSES).optional(),
  language: trimString(12, 'en').optional(),
  // twoFactorEnabled is server-owned (profile-preferences.js); an unknown key like it is stripped.
}).partial();

export const updateProfileSchema = z.object({
  firstName: requiredString(255),
  lastName: requiredString(255),
  profileDisplayName: requiredString(255),
  title: trimString(255, '').optional().default(''),
  department: trimString(255, '').optional().default(''),
  aboutMe: trimString(65_535, '').optional().default(''),
  email: optionalEmail(),
  phone: trimString(100, '').optional().default(''),
  timezone: trimString(150, 'America/New_York').optional().default('America/New_York'),
  preferences: userPreferencesSchema.optional().default({}),
  currentPassword: trimString(200, '').optional().default(''),
  newPassword: trimString(200, '').optional().default(''),
  confirmNewPassword: trimString(200, '').optional().default(''),
  base64Avatar: optionalDataUrl().optional().default(''),
});

export const killSessionSchema = z.object({
  tgtSession: z.string().trim().min(1).max(64),
});
