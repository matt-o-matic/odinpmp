import express, { Router } from 'express';
import { z } from 'zod';

import { issueSessionCookies } from '../../lib/auth/auth-cookies.js';
import { buildRequestLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { getLocationNameForIp, getRequestIp, getRequestUserAgent } from '../../lib/http/request-meta.js';

const discoverSchema = z.object({ email: z.string().trim().email().max(320) });
const startSchema = z.object({ redirect: z.string().trim().max(2000).optional().default('/'), tenantId: z.string().uuid() });
function frontendUrl(base, path, parameters = {}) { const url = new URL(path, String(base).endsWith('/') ? base : `${base}/`); for (const [key, value] of Object.entries(parameters)) if (value) url.searchParams.set(key, value); return url.toString(); }

export function createEnterpriseOidcRouter({ backendPublicUrl, enterpriseOidcService, enterpriseSamlService, frontendAppUrl, tokenService }) {
  const router = Router();
  router.get('/discover', async (request, response, next) => { try { response.json(await enterpriseOidcService.discover(discoverSchema.parse(request.query))); } catch (error) { next(error); } });
  router.get('/oidc/start', async (request, response, next) => { try { response.redirect(302, await enterpriseOidcService.begin(startSchema.parse(request.query))); } catch (error) { next(error); } });
  router.get('/oidc/callback', async (request, response) => { try { const base = new URL('/api/auth/sso/oidc/callback', backendPublicUrl ?? frontendAppUrl); base.search = new URL(request.originalUrl, base.origin).search; const ipAddr = getRequestIp(request); const result = await enterpriseOidcService.callback({ callbackRequestUrl: base.toString(), ipAddr, locationName: getLocationNameForIp(ipAddr), userAgent: getRequestUserAgent(request) }); issueSessionCookies(response, result.session, tokenService); response.redirect(302, frontendUrl(frontendAppUrl, 'oauth/callback', { redirect: result.redirect })); } catch (error) { logBackendError({ context: buildRequestLogContext(request), error, level: 'warn', message: 'Enterprise OIDC callback failed.' }); response.redirect(302, frontendUrl(frontendAppUrl, 'login', { ssoError: 'Enterprise SSO could not be completed.' })); } });
  router.get('/saml/start', async (request, response, next) => { try { response.redirect(302, await enterpriseSamlService.begin(startSchema.parse(request.query))); } catch (error) { next(error); } });
  router.post('/saml/callback', express.urlencoded({ extended: false, limit: '1mb' }), async (request, response) => { try { const ipAddr = getRequestIp(request); const result = await enterpriseSamlService.callback({ body: request.body, ipAddr, locationName: getLocationNameForIp(ipAddr), userAgent: getRequestUserAgent(request) }); issueSessionCookies(response, result.session, tokenService); response.redirect(302, frontendUrl(frontendAppUrl, 'oauth/callback', { redirect: result.redirect })); } catch (error) { logBackendError({ context: buildRequestLogContext(request), error, level: 'warn', message: 'Enterprise SAML callback failed.' }); response.redirect(302, frontendUrl(frontendAppUrl, 'login', { ssoError: 'Enterprise SSO could not be completed.' })); } });
  router.get('/saml/metadata/:tenantId', async (request, response, next) => { try { const tenantId = z.string().uuid().parse(request.params.tenantId); response.type('application/samlmetadata+xml').send(await enterpriseSamlService.metadata({ tenantId })); } catch (error) { next(error); } });
  return router;
}
