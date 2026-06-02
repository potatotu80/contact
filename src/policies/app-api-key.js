'use strict';

const { findTenantByApiKey, findTenantLaunchByQrToken, findTenantLaunchByReferralCode } = require('../utils/tenant-access');

const getClientIp = (ctx) => {
  const forwardedFor = ctx.request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return ctx.request.ip || ctx.ip || 'unknown';
};

const maskKey = (value) => {
  const key = String(value || '').trim();
  if (!key) {
    return '(empty)';
  }

  if (key.length <= 10) {
    return `${key.slice(0, 2)}...${key.slice(-2)}`;
  }

  return `${key.slice(0, 8)}...${key.slice(-6)}`;
};

const rejectForbidden = (ctx, message) => {
  ctx.status = 403;
  ctx.body = {
    data: null,
    error: {
      status: 403,
      name: 'ForbiddenError',
      message,
      details: {},
    },
  };
  return false;
};

module.exports = async (policyContext, _config, { strapi }) => {
  const headerKey = (
    policyContext.request.headers['x-app-api-key']
    || policyContext.request.headers['x-app-write-key']
    || ''
  ).trim();
  const qrTokenHeader = String(
    policyContext.request.headers['x-tenant-qr-token']
    || policyContext.request.headers['x-app-launch-token']
    || ''
  ).trim();

  const authHeader = (policyContext.request.headers.authorization || '').trim();
  const bearerPrefix = 'Bearer ';
  const bearerToken = authHeader.startsWith(bearerPrefix)
    ? authHeader.slice(bearerPrefix.length).trim()
    : '';
  const referralCode = String(
    policyContext.request.body?.referralCode
    || policyContext.request.query?.referralCode
    || policyContext.request.headers['x-referral-code']
    || ''
  ).trim();

  const presentedKey = qrTokenHeader || headerKey || bearerToken;

  const adminUser = policyContext.state?.admin?.user;
  if (adminUser?.id) {
    return true;
  }

  if (!presentedKey && !referralCode) {
    strapi.log.warn(
      `[app-api-key] Missing tenant API key for ${policyContext.request.method} ${policyContext.request.path} ` +
      `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
    );
    return rejectForbidden(policyContext, 'Invalid tenant launch token or application API key.');
  }

  const launchContext = qrTokenHeader
    ? await findTenantLaunchByQrToken(strapi, qrTokenHeader)
    : null;
  const referralLaunchContext = !launchContext && referralCode
    ? await findTenantLaunchByReferralCode(strapi, referralCode)
    : null;
  const tenant =
    launchContext?.tenant
    || await findTenantByApiKey(strapi, presentedKey)
    || referralLaunchContext?.tenant;
  if (tenant) {
    strapi.log.info(
      `[app-api-key] Accepted ${policyContext.request.method} ${policyContext.request.path} ` +
      `tenant=${tenant.slug || tenant.id} key=${maskKey(presentedKey || referralCode)} ` +
      `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
    );
    policyContext.state.appTenant = tenant;
    const resolvedTenantAdmin = launchContext?.tenantAdmin || referralLaunchContext?.tenantAdmin || null;
    if (resolvedTenantAdmin) {
      policyContext.state.appTenantAdmin = resolvedTenantAdmin;
      policyContext.state.appLaunchToken = resolvedTenantAdmin.qr_token;
    }
    return true;
  }

  strapi.log.warn(
    `[app-api-key] Blocked ${policyContext.request.method} ${policyContext.request.path} ` +
    `key=${maskKey(presentedKey)} ` +
    `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
  );

  return rejectForbidden(policyContext, 'Invalid tenant launch token or application API key.');
};
