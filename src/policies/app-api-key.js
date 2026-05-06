'use strict';

const { findTenantByApiKey } = require('../utils/tenant-access');

const getClientIp = (ctx) => {
  const forwardedFor = ctx.request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return ctx.request.ip || ctx.ip || 'unknown';
};

module.exports = async (policyContext, _config, { strapi }) => {
  const headerKey = (
    policyContext.request.headers['x-app-api-key']
    || policyContext.request.headers['x-app-write-key']
    || ''
  ).trim();

  const authHeader = (policyContext.request.headers.authorization || '').trim();
  const bearerPrefix = 'Bearer ';
  const bearerToken = authHeader.startsWith(bearerPrefix)
    ? authHeader.slice(bearerPrefix.length).trim()
    : '';

  const presentedKey = headerKey || bearerToken;

  const adminUser = policyContext.state?.admin?.user;
  if (adminUser?.id) {
    return true;
  }

  if (!presentedKey) {
    strapi.log.warn(
      `[app-api-key] Missing tenant API key for ${policyContext.request.method} ${policyContext.request.path} ` +
      `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
    );
    return policyContext.forbidden('Invalid application API key.');
  }

  const tenant = await findTenantByApiKey(strapi, presentedKey);
  if (tenant) {
    policyContext.state.appTenant = tenant;
    return true;
  }

  strapi.log.warn(
    `[app-api-key] Blocked ${policyContext.request.method} ${policyContext.request.path} ` +
    `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
  );

  return policyContext.forbidden('Invalid application API key.');
};
