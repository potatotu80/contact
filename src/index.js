'use strict';

const AWS = require('aws-sdk');
const QRCode = require('qrcode');
const twilio = require('twilio');
const { generateTenantApiKey } = require('./utils/tenant-api-key');
const {
  buildTenantAdminQrCodeUrl,
  getSharedAndroidApplicationId,
  getSharedDeepLinkScheme,
} = require('./utils/app-launch');
const {
  APP_TENANT_ADMIN_UID,
  APP_TENANT_UID,
  APP_USER_UID,
  CONTACT_UID,
  assertTenantScopeForContact,
  assertTenantScopeForUser,
  buildTenantUserImagePrefix,
  findTenantLaunchByQrToken,
  getAdminTenantContext,
  getTenantIdsFilter,
  parsePositiveInt,
} = require('./utils/tenant-access');
const TENANT_ADMIN_BULK_SENTINEL = '__tenant_admin_bulk__:';

const buildS3ObjectUrl = (bucket, region, key) => {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
};

const buildVoiceIdentity = (adminUser) => {
  const prefix = (process.env.TWILIO_VOICE_IDENTITY_PREFIX || 'admin').trim() || 'admin';
  return `${prefix}-${adminUser.id}`;
};

const getAdminRequestUserFromState = (ctx) => ctx.state?.user || ctx.state?.admin?.user || ctx.state?.adminUser || null;

const getAdminRequestUser = async (ctx, strapi) => {
  const adminUser = getAdminRequestUserFromState(ctx);
  if (adminUser?.id) {
    return adminUser;
  }

  const authorization = ctx.request.header?.authorization || '';
  const parts = authorization.split(/\s+/);
  if (parts[0]?.toLowerCase() !== 'bearer' || parts.length !== 2) {
    return null;
  }

  const tokenService = strapi.admin?.services?.token;
  if (!tokenService?.decodeJwtToken) {
    return null;
  }

  const { payload, isValid } = tokenService.decodeJwtToken(parts[1]);
  if (!isValid || !payload?.id) {
    return null;
  }

  return { id: payload.id };
};

const getTwilioVoiceConfig = () => ({
  accountSid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
  apiKeySid: (process.env.TWILIO_VOICE_API_KEY_SID || '').trim(),
  apiKeySecret: (process.env.TWILIO_VOICE_API_KEY_SECRET || '').trim(),
  twimlAppSid: (process.env.TWILIO_VOICE_TWIML_APP_SID || '').trim(),
  callerId: (process.env.TWILIO_VOICE_CALLER_ID || '').trim(),
  tokenTtl: parsePositiveInt(process.env.TWILIO_VOICE_TOKEN_TTL) || 3600,
});

const createVoiceAccessToken = (adminUser) => {
  const config = getTwilioVoiceConfig();

  if (!config.accountSid || !config.apiKeySid || !config.apiKeySecret || !config.twimlAppSid || !config.callerId) {
    throw new Error(
      'Twilio Voice configuration is incomplete. Required: TWILIO_ACCOUNT_SID, ' +
      'TWILIO_VOICE_API_KEY_SID, TWILIO_VOICE_API_KEY_SECRET, TWILIO_VOICE_TWIML_APP_SID, ' +
      'TWILIO_VOICE_CALLER_ID.'
    );
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const token = new AccessToken(
    config.accountSid,
    config.apiKeySid,
    config.apiKeySecret,
    {
      identity: buildVoiceIdentity(adminUser),
      ttl: config.tokenTtl,
    }
  );

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: config.twimlAppSid,
      incomingAllow: false,
    })
  );

  return {
    token: token.toJwt(),
    identity: buildVoiceIdentity(adminUser),
    callerId: config.callerId,
    expiresIn: config.tokenTtl,
  };
};

const getContentManagerSlug = (requestPath) => {
  const match = requestPath.match(/\/content-manager\/collection-types\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

const getContentManagerEntityId = (requestPath) => {
  const match = requestPath.match(/\/content-manager\/collection-types\/[^/]+\/(\d+)/);
  return parsePositiveInt(match?.[1]);
};

const getContentManagerRelationParams = (requestPath) => {
  const existingMatch = requestPath.match(/^\/content-manager\/relations\/([^/]+)\/(\d+)\/([^/]+)/);
  if (existingMatch) {
    return {
      model: decodeURIComponent(existingMatch[1]),
      entityId: parsePositiveInt(existingMatch[2]),
      targetField: decodeURIComponent(existingMatch[3]),
      mode: 'existing',
    };
  }

  const availableMatch = requestPath.match(/^\/content-manager\/relations\/([^/]+)\/([^/]+)/);
  if (availableMatch) {
    return {
      model: decodeURIComponent(availableMatch[1]),
      entityId: null,
      targetField: decodeURIComponent(availableMatch[2]),
      mode: 'available',
    };
  }

  return null;
};

const getRequestData = (ctx) => {
  if (ctx.request.body?.data && typeof ctx.request.body.data === 'object') {
    return ctx.request.body.data;
  }

  if (ctx.request.body && typeof ctx.request.body === 'object') {
    return ctx.request.body;
  }

  return null;
};

const setRequestData = (ctx, nextData) => {
  if (ctx.request.body?.data && typeof ctx.request.body.data === 'object') {
    ctx.request.body.data = nextData;
    return;
  }

  ctx.request.body = nextData;
};

const resolveTenantRelationIds = (value) => {
  if (!value) {
    return [];
  }

  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = parsePositiveInt(value);
    return parsed ? [parsed] : [];
  }

  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => parsePositiveInt(entry?.id || entry)).filter(Boolean))];
  }

  if (Array.isArray(value?.connect)) {
    return [...new Set(value.connect.map((entry) => parsePositiveInt(entry?.id || entry)).filter(Boolean))];
  }

  if (typeof value?.id === 'number' || typeof value?.id === 'string') {
    const parsed = parsePositiveInt(value.id);
    return parsed ? [parsed] : [];
  }

  return [];
};

const resolveTenantAdminBulkTenantIds = (data) => {
  const relationTenantIds = resolveTenantRelationIds(data?.tenant);
  if (relationTenantIds.length > 0) {
    return relationTenantIds;
  }

  const qrCodeUrlValue = String(data?.qr_code_url || '').trim();
  if (!qrCodeUrlValue.startsWith(TENANT_ADMIN_BULK_SENTINEL)) {
    return [];
  }

  try {
    const parsed = JSON.parse(qrCodeUrlValue.slice(TENANT_ADMIN_BULK_SENTINEL.length));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return [...new Set(parsed.map((entry) => parsePositiveInt(entry)).filter(Boolean))];
  } catch (error) {
    return [];
  }
};

const stripManagedTenantFields = (ctx, slug) => {
  if (slug !== APP_TENANT_UID) {
    return;
  }

  const data = getRequestData(ctx);
  if (!data || typeof data !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'app_api_key')) {
    delete data.app_api_key;
    setRequestData(ctx, data);
  }
};

const withAdminTenantFilter = (ctx, tenantIds) => {
  const tenantFilter = getTenantIdsFilter(tenantIds);
  const existingFilters = ctx.query?.filters || ctx.request?.query?.filters;

  if (!existingFilters || Object.keys(existingFilters).length === 0) {
    if (!ctx.query) {
      ctx.query = {};
    }
    if (!ctx.request.query) {
      ctx.request.query = {};
    }

    ctx.query.filters = tenantFilter;
    ctx.request.query.filters = tenantFilter;
    return;
  }

  const combinedFilters = {
    $and: [existingFilters, tenantFilter],
  };

  ctx.query.filters = combinedFilters;
  ctx.request.query.filters = combinedFilters;
};

const enforceTenantOnAdminBody = (ctx, tenantContext, slug) => {
  const data = getRequestData(ctx);
  if (!data || typeof data !== 'object') {
    return true;
  }

  if (slug === APP_TENANT_UID || slug === APP_TENANT_ADMIN_UID) {
    return false;
  }

  const nextData = {
    ...data,
  };

  if (tenantContext.tenantIds.length === 1) {
    nextData.tenant = tenantContext.tenantIds[0];
    setRequestData(ctx, nextData);
    return true;
  }

  const requestedTenantId = parsePositiveInt(data.tenant?.id || data.tenant);
  if (requestedTenantId && tenantContext.tenantIds.includes(requestedTenantId)) {
    setRequestData(ctx, nextData);
    return true;
  }

  return false;
};

const attachTenantScopedContentManagerControllers = (strapi) => {
  const controller = strapi.plugin('content-manager')?.controller('collection-types');
  if (!controller || controller.__tenantScopedWrapped) {
    return;
  }

  const originalFind = controller.find.bind(controller);
  const originalFindOne = controller.findOne.bind(controller);
  const getForcedTenantPopulate = (model) => {
    if (model === APP_TENANT_ADMIN_UID) {
      return {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      };
    }

    if (model === APP_USER_UID) {
      return {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      };
    }

    if (model === CONTACT_UID) {
      return {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
        user: {
          fields: ['id', 'email', 'device_id'],
          populate: {
            tenant: {
              fields: ['id', 'name', 'slug'],
            },
          },
        },
      };
    }

    return {};
  };

  controller.find = async (ctx) => {
    const model = ctx.params?.model;
    if (model !== APP_USER_UID && model !== CONTACT_UID && model !== APP_TENANT_UID && model !== APP_TENANT_ADMIN_UID) {
      return originalFind(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFind(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin) {
      return originalFind(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    if (model === APP_TENANT_UID) {
      const mergedFilters =
        ctx.request.query?.filters && Object.keys(ctx.request.query.filters).length
          ? {
              $and: [ctx.request.query.filters, { id: { $in: tenantContext.tenantIds } }],
            }
          : { id: { $in: tenantContext.tenantIds } };

      const page = Math.max(1, Number(ctx.request.query?.page) || 1);
      const pageSize = Math.max(1, Math.min(100, Number(ctx.request.query?.pageSize) || 10));
      const start = (page - 1) * pageSize;
      const sort = ctx.request.query?.sort || ['id:asc'];
      const [results, total] = await Promise.all([
        strapi.entityService.findMany(APP_TENANT_UID, {
          filters: mergedFilters,
          fields: Object.keys(strapi.getModel(APP_TENANT_UID)?.attributes || {}),
          sort,
          start,
          limit: pageSize,
          populate: {
            brand_logo: true,
          },
        }),
        strapi.db.query(APP_TENANT_UID).count({
          where: mergedFilters,
        }),
      ]);

      ctx.body = {
        results,
        pagination: {
          page,
          pageSize,
          pageCount: Math.ceil(total / pageSize),
          total,
        },
      };
      return;
    }

    if (model === APP_TENANT_ADMIN_UID) {
      const mergedFilters =
        ctx.request.query?.filters && Object.keys(ctx.request.query.filters).length
          ? {
              $and: [
                ctx.request.query.filters,
                { admin_user_id: { $eq: adminUser.id } },
                { tenant: { id: { $in: tenantContext.tenantIds } } },
              ],
            }
          : {
              $and: [
                { admin_user_id: { $eq: adminUser.id } },
                { tenant: { id: { $in: tenantContext.tenantIds } } },
              ],
            };

      const page = Math.max(1, Number(ctx.request.query?.page) || 1);
      const pageSize = Math.max(1, Math.min(100, Number(ctx.request.query?.pageSize) || 10));
      const start = (page - 1) * pageSize;
      const sort = ctx.request.query?.sort || ['id:asc'];
      const [results, total] = await Promise.all([
        strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
          filters: mergedFilters,
          fields: Object.keys(strapi.getModel(APP_TENANT_ADMIN_UID)?.attributes || {}),
          sort,
          start,
          limit: pageSize,
          populate: {
            tenant: {
              fields: ['id', 'name', 'slug'],
            },
          },
        }),
        strapi.db.query(APP_TENANT_ADMIN_UID).count({
          where: mergedFilters,
        }),
      ]);

      ctx.body = {
        results,
        pagination: {
          page,
          pageSize,
          pageCount: Math.ceil(total / pageSize),
          total,
        },
      };
      return;
    }

    const { userAbility } = ctx.state;
    const entityManager = strapi.plugin('content-manager').service('entity-manager');
    const permissionChecker = strapi
      .plugin('content-manager')
      .service('permission-checker')
      .create({ userAbility, model });

    if (permissionChecker.cannot.read()) {
      return ctx.forbidden();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.read(ctx.request.query);
    const populate = await strapi
      .plugin('content-manager')
      .service('populate-builder')(model)
      .populateDeep(1)
      .countRelations({ toOne: false, toMany: true })
      .build();

    const mergedFilters =
      permissionQuery.filters && Object.keys(permissionQuery.filters).length
        ? {
            $and: [permissionQuery.filters, getTenantIdsFilter(tenantContext.tenantIds)],
          }
        : getTenantIdsFilter(tenantContext.tenantIds);

    const { results, pagination } = await entityManager.findPage(
      {
        ...permissionQuery,
        filters: mergedFilters,
        populate,
      },
      model
    );

    ctx.body = {
      results,
      pagination,
    };
  };

  controller.findOne = async (ctx) => {
    const model = ctx.params?.model;
    if (model !== APP_USER_UID && model !== CONTACT_UID && model !== APP_TENANT_UID && model !== APP_TENANT_ADMIN_UID) {
      return originalFindOne(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFindOne(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin) {
      return originalFindOne(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    const entityId = parsePositiveInt(ctx.params?.id);
    if (!entityId) {
      return ctx.badRequest('Entry id must be a valid number.');
    }

    if (model === APP_TENANT_UID) {
      if (!tenantContext.tenantIds.includes(entityId)) {
        return ctx.forbidden('This tenant is outside your scope.');
      }

      const entity = await strapi.entityService.findOne(APP_TENANT_UID, entityId, {
        fields: Object.keys(strapi.getModel(APP_TENANT_UID)?.attributes || {}),
        populate: {
          brand_logo: true,
        },
      });

      if (!entity) {
        return ctx.notFound();
      }

      ctx.body = entity;
      return;
    }

    if (model === APP_TENANT_ADMIN_UID) {
      const entity = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
        filters: {
          id: {
            $eq: entityId,
          },
          admin_user_id: {
            $eq: adminUser.id,
          },
          tenant: {
            id: {
              $in: tenantContext.tenantIds,
            },
          },
        },
        fields: Object.keys(strapi.getModel(APP_TENANT_ADMIN_UID)?.attributes || {}),
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
        limit: 1,
      });

      if (!entity[0]) {
        return ctx.forbidden('This tenant admin record is outside your scope.');
      }

      ctx.body = entity[0];
      return;
    }

    const allowed = await Promise.all(
      tenantContext.tenantIds.map((tenantId) =>
        model === APP_USER_UID
          ? assertTenantScopeForUser(strapi, tenantId, entityId)
          : assertTenantScopeForContact(strapi, tenantId, entityId)
      )
    );

    if (!allowed.some(Boolean)) {
      return ctx.forbidden('This record is outside your tenants.');
    }

    const { userAbility } = ctx.state;
    const entityManager = strapi.plugin('content-manager').service('entity-manager');
    const permissionChecker = strapi
      .plugin('content-manager')
      .service('permission-checker')
      .create({ userAbility, model });

    if (permissionChecker.cannot.read()) {
      return ctx.forbidden();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.read(ctx.query);
    const populate = await strapi
      .plugin('content-manager')
      .service('populate-builder')(model)
      .populateFromQuery(permissionQuery)
      .populateDeep(Infinity)
      .countRelations()
      .build();

    const forcedPopulate = getForcedTenantPopulate(model);

    const entity = await entityManager.findOne(entityId, model, {
      populate: {
        ...populate,
        ...forcedPopulate,
      },
    });
    if (!entity) {
      return ctx.notFound();
    }

    ctx.body = entity;
  };

  controller.__tenantScopedWrapped = true;
};

const attachTenantScopedRelationControllers = (strapi) => {
  const controller = strapi.plugin('content-manager')?.controller('relations');
  if (!controller || controller.__tenantScopedWrapped) {
    return;
  }

  const originalFindExisting = controller.findExisting.bind(controller);

  controller.findExisting = async (ctx) => {
    const { model, id, targetField } = ctx.params;
    const supportedModel = model === APP_USER_UID || model === CONTACT_UID;

    if (!supportedModel || targetField !== 'tenant') {
      return originalFindExisting(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFindExisting(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin) {
      return originalFindExisting(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    const entityId = parsePositiveInt(id);
    if (!entityId) {
      return ctx.badRequest('Entry id must be a valid number.');
    }

    const allowed = await Promise.all(
      tenantContext.tenantIds.map((tenantId) =>
        model === APP_USER_UID
          ? assertTenantScopeForUser(strapi, tenantId, entityId)
          : assertTenantScopeForContact(strapi, tenantId, entityId)
      )
    );

    const entity = allowed.find(Boolean);
    if (!entity) {
      return ctx.forbidden('This record is outside your tenants.');
    }

    const tenant = entity.tenant || null;
    ctx.body = {
      data: tenant
        ? {
            id: tenant.id,
            name: tenant.name || tenant.slug || String(tenant.id),
            slug: tenant.slug || null,
          }
        : null,
    };
  };

  controller.__tenantScopedWrapped = true;
};

const attachTenantAdminPermissionExpansion = (strapi) => {
  const controller =
    strapi.admin?.controllers?.['authenticated-user'] ||
    strapi.admin?.controllers?.authenticatedUser;
  if (!controller || controller.__tenantPermissionWrapped) {
    return;
  }

  const originalGetOwnPermissions = controller.getOwnPermissions.bind(controller);
  const managedSubjects = [APP_USER_UID, CONTACT_UID, APP_TENANT_UID, APP_TENANT_ADMIN_UID];
  const fieldsBySubject = Object.fromEntries(
    managedSubjects.map((uid) => [uid, Object.keys(strapi.getModel(uid)?.attributes || {})])
  );

  controller.getOwnPermissions = async (ctx) => {
    const adminUser = ctx.state?.user;
    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin || !tenantContext.tenantIds.length) {
      return originalGetOwnPermissions(ctx);
    }

    const { findUserPermissions, sanitizePermission } = strapi.admin.services.permission;
    const userPermissions = await findUserPermissions(adminUser);

    const expandedPermissions = userPermissions.map((permission) => {
      if (!managedSubjects.includes(permission.subject)) {
        return permission;
      }

      const action = permission.action || '';
      if (
        !action.endsWith('.read') &&
        !action.endsWith('.create') &&
        !action.endsWith('.update')
      ) {
        return permission;
      }

      return {
        ...permission,
        properties: {
          ...(permission.properties || {}),
          fields: fieldsBySubject[permission.subject],
        },
      };
    });

    const hasTenantAdminReadPermission = expandedPermissions.some(
      (permission) =>
        permission.subject === APP_TENANT_ADMIN_UID &&
        String(permission.action || '').endsWith('.read')
    );

    if (!hasTenantAdminReadPermission) {
      const templateReadPermission = expandedPermissions.find(
        (permission) =>
          managedSubjects.includes(permission.subject) &&
          permission.subject !== APP_TENANT_ADMIN_UID &&
          String(permission.action || '').endsWith('.read')
      );

      if (templateReadPermission) {
        expandedPermissions.push({
          ...templateReadPermission,
          subject: APP_TENANT_ADMIN_UID,
          properties: {
            ...(templateReadPermission.properties || {}),
            fields: fieldsBySubject[APP_TENANT_ADMIN_UID],
          },
        });
      }
    }

    ctx.body = {
      data: expandedPermissions.map(sanitizePermission),
    };
  };

  controller.__tenantPermissionWrapped = true;
};

const syncTenantAdminListConfiguration = async (strapi) => {
  const contentTypesService = strapi.plugin('content-manager')?.service('content-types');
  if (!contentTypesService) {
    return;
  }

  const tenantAdminContentType = contentTypesService.findContentType(APP_TENANT_ADMIN_UID);
  if (!tenantAdminContentType) {
    return;
  }

  const configuration = await contentTypesService.findConfiguration(tenantAdminContentType);
  const desiredListLayout = ['tenant_name', 'tenant', 'admin_email', 'qr_code_url'];
  const nextConfiguration = {
    ...configuration,
    settings: {
      ...(configuration.settings || {}),
      mainField: 'tenant_name',
    },
    layouts: {
      ...(configuration.layouts || {}),
      list: desiredListLayout,
    },
    metadatas: {
      ...(configuration.metadatas || {}),
      tenant_name: {
        ...(configuration.metadatas?.tenant_name || {}),
        list: {
          ...(configuration.metadatas?.tenant_name?.list || {}),
          label: 'Tenant Name',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.tenant_name?.edit || {}),
          label: 'Tenant Name',
        },
      },
      tenant: {
        ...(configuration.metadatas?.tenant || {}),
        list: {
          ...(configuration.metadatas?.tenant?.list || {}),
          label: 'Linked Tenant',
        },
        edit: {
          ...(configuration.metadatas?.tenant?.edit || {}),
          label: 'Linked Tenant',
          mainField: 'name',
        },
      },
      admin_email: {
        ...(configuration.metadatas?.admin_email || {}),
        list: {
          ...(configuration.metadatas?.admin_email?.list || {}),
          label: 'Admin Email',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.admin_email?.edit || {}),
          label: 'Admin Email',
        },
      },
      qr_code_url: {
        ...(configuration.metadatas?.qr_code_url || {}),
        list: {
          ...(configuration.metadatas?.qr_code_url?.list || {}),
          label: 'QR URL',
          searchable: false,
          sortable: false,
        },
        edit: {
          ...(configuration.metadatas?.qr_code_url?.edit || {}),
          label: 'QR URL',
        },
      },
      qr_token: {
        ...(configuration.metadatas?.qr_token || {}),
        edit: {
          ...(configuration.metadatas?.qr_token?.edit || {}),
          label: 'QR Token',
        },
      },
    },
  };

  await contentTypesService.updateConfiguration(tenantAdminContentType, nextConfiguration);
};

const buildScopedTenantAdminListResponse = async ({ strapi, adminUserId, tenantIds, requestQuery }) => {
  const mergedFilters =
    requestQuery?.filters && Object.keys(requestQuery.filters).length
      ? {
          $and: [
            requestQuery.filters,
            { admin_user_id: { $eq: adminUserId } },
            { tenant: { id: { $in: tenantIds } } },
          ],
        }
      : {
          $and: [
            { admin_user_id: { $eq: adminUserId } },
            { tenant: { id: { $in: tenantIds } } },
          ],
        };

  const page = Math.max(1, Number(requestQuery?.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(requestQuery?.pageSize) || 10));
  const start = (page - 1) * pageSize;
  const sort = String(requestQuery?.sort || 'id:asc').toLowerCase();
  const [results, total] = await Promise.all([
    strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
      filters: mergedFilters,
      sort,
      start,
      limit: pageSize,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    }),
    strapi.db.query(APP_TENANT_ADMIN_UID).count({
      where: mergedFilters,
    }),
  ]);

  return {
    results,
    pagination: {
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
      total,
    },
  };
};

const findScopedTenantAdminRecord = async ({ strapi, adminUserId, tenantIds, entityId }) => {
  const results = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
    filters: {
      id: {
        $eq: entityId,
      },
      admin_user_id: {
        $eq: adminUserId,
      },
      tenant: {
        id: {
          $in: tenantIds,
        },
      },
    },
    populate: {
      tenant: {
        fields: ['id', 'name', 'slug'],
      },
    },
    limit: 1,
  });

  return results[0] || null;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const ensureAbsoluteUrl = (value) => {
  const normalized = String(value || '').trim();
  return /^https?:\/\//i.test(normalized) ? normalized : '';
};

const buildTenantDeepLinkUrl = ({ tenantCode, referralCode, qrToken }) => {
  const scheme = getSharedDeepLinkScheme();
  if (!scheme) {
    return '';
  }

  const params = new URLSearchParams();
  if (qrToken) {
    params.set('qrToken', qrToken);
  }
  if (tenantCode) {
    params.set('tenantCode', tenantCode);
  }
  if (referralCode) {
    params.set('referralCode', referralCode);
  }

  const query = params.toString();
  return `${scheme}://open${query ? `?${query}` : ''}`;
};

const buildTenantIntentUrl = ({ tenantCode, referralCode, qrToken }) => {
  const scheme = getSharedDeepLinkScheme();
  const packageName = getSharedAndroidApplicationId();
  if (!scheme || !packageName) {
    return '';
  }

  const params = new URLSearchParams();
  if (qrToken) {
    params.set('qrToken', qrToken);
  }
  if (tenantCode) {
    params.set('tenantCode', tenantCode);
  }
  if (referralCode) {
    params.set('referralCode', referralCode);
  }

  const query = params.toString();
  return `intent://open${query ? `?${query}` : ''}#Intent;scheme=${encodeURIComponent(scheme)};package=${encodeURIComponent(packageName)};end`;
};

const renderQrLandingHtml = ({ tenant, tenantCode, referralCode, qrCodeUrl, qrToken, isAndroidRequest }) => {
  const appName = escapeHtml(tenant?.app_display_name || tenant?.name || 'Member Reward');
  const primaryColor = /^#[0-9A-Fa-f]{6}$/.test(String(tenant?.primary_color || '').trim())
    ? tenant.primary_color
    : '#2F6BFF';
  const installUrl = ensureAbsoluteUrl(tenant?.android_apk_url);
  const deepLinkUrl = buildTenantDeepLinkUrl({ tenantCode, referralCode, qrToken });
  const intentUrl = buildTenantIntentUrl({ tenantCode, referralCode, qrToken });
  const safeMessage = escapeHtml('Please open this link on an Android device.');
  const safeQrUrl = escapeHtml(qrCodeUrl || '');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${appName} | Open App</title>
    <style>
      :root {
        --primary: ${escapeHtml(primaryColor)};
        --text: #162038;
        --muted: #61708c;
        --surface: #ffffff;
        --border: #dbe2ef;
        --bg: linear-gradient(180deg, #f7faff 0%, #eef3fb 100%);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", Tahoma, sans-serif;
        color: var(--text);
        background: var(--bg);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: min(100%, 480px);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: 0 24px 48px rgba(30, 53, 107, 0.12);
        padding: 28px;
      }
      .eyebrow {
        margin: 0 0 10px;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--primary);
        font-weight: 700;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 30px;
        line-height: 1.1;
      }
      p {
        margin: 0;
        line-height: 1.65;
        color: var(--muted);
      }
      .status {
        margin-top: 18px;
      }
      .install-box {
        display: none;
        margin-top: 24px;
      }
      .install-box.android-delayed {
        display: block;
        opacity: 0;
        visibility: hidden;
        animation: revealInstall 0s linear 2.2s forwards;
      }
      .install-button {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 14px 18px;
        border-radius: 14px;
        background: var(--primary);
        color: #fff;
        text-decoration: none;
        font-weight: 700;
      }
      .hint {
        margin-top: 12px;
        font-size: 13px;
      }
      code {
        display: block;
        margin-top: 20px;
        padding: 12px 14px;
        border-radius: 12px;
        background: #f5f7fb;
        color: #34415e;
        word-break: break-all;
      }
      @keyframes revealInstall {
        to {
          opacity: 1;
          visibility: visible;
        }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <p class="eyebrow">${appName}</p>
      <h1>Open in app</h1>
      <p id="message">Trying to open the Android app…</p>
      <p class="status" id="status"></p>
      <div class="install-box ${isAndroidRequest ? 'android-delayed' : ''}" id="installBox">
        <a class="install-button" id="installButton" href="${escapeHtml(installUrl)}" download>Install Android app</a>
        <p class="hint">If the app did not open, install the latest APK and try the QR again.</p>
      </div>
      <div class="install-box" id="openAppBox">
        <a class="install-button" href="${escapeHtml(intentUrl || deepLinkUrl)}">Open app manually</a>
      </div>
      ${safeQrUrl ? `<code>${safeQrUrl}</code>` : ''}
    </main>
    <script>
      (function () {
        var isAndroid = /Android/i.test(navigator.userAgent || "");
        var installUrl = ${JSON.stringify(installUrl)};
        var deepLinkUrl = ${JSON.stringify(deepLinkUrl)};
        var intentUrl = ${JSON.stringify(intentUrl)};
        var installBox = document.getElementById("installBox");
        var installButton = document.getElementById("installButton");
        var openAppBox = document.getElementById("openAppBox");
        var message = document.getElementById("message");
        var status = document.getElementById("status");

        if (!isAndroid) {
          message.textContent = ${JSON.stringify(safeMessage)};
          status.textContent = "";
          if (installButton) installButton.style.display = "none";
          if (installBox) installBox.style.display = "none";
          if (openAppBox) openAppBox.style.display = "none";
          return;
        }

        if (!deepLinkUrl) {
          message.textContent = "This app link is missing QR launch metadata.";
          if (installButton) {
            installButton.style.display = installUrl ? "inline-flex" : "none";
          }
          if (installBox) {
            installBox.style.display = "block";
            installBox.style.opacity = "1";
            installBox.style.visibility = "visible";
          }
          if (openAppBox) {
            openAppBox.style.display = "none";
          }
          return;
        }

        if (!installUrl) {
          message.textContent = "This tenant is missing an APK download URL.";
          if (installButton) {
            installButton.style.display = "none";
          }
        }

        var fallbackDelayMs = 2200;
        status.textContent = "If nothing happens, the install button will appear in a moment.";

        window.setTimeout(function () {
          if (installBox) {
            installBox.style.display = "block";
            installBox.style.opacity = "1";
            installBox.style.visibility = "visible";
            status.textContent = installUrl
              ? "App not detected. Install the latest Android APK below."
              : "App not detected, and this tenant is missing an APK download URL.";
            if (!installUrl && installButton) {
              installButton.style.display = "none";
            }
          }
          if (openAppBox && (intentUrl || deepLinkUrl)) {
            openAppBox.style.display = "block";
          }
        }, fallbackDelayMs);

        window.setTimeout(function () {
          if (intentUrl) {
            window.location.assign(intentUrl);
            return;
          }

          var iframe = document.createElement("iframe");
          iframe.style.display = "none";
          iframe.src = deepLinkUrl;
          document.body.appendChild(iframe);

          window.setTimeout(function () {
            try {
              document.body.removeChild(iframe);
            } catch (error) {
              // Ignore DOM cleanup issues for the fallback probe.
            }
          }, 1000);
        }, 120);
      })();
    </script>
  </body>
</html>`;
};

const PRIVACY_POLICY_SECTIONS = [
  {
    title: '1. Information We Collect',
    paragraphs: [
      'The app may collect the following information with user permission:',
    ],
    items: [
      'Contacts: to allow users to access and manage their contact list within the app',
      'Photos/Media: to allow users to select and upload images',
      'Basic device information (e.g. device ID) for app functionality',
    ],
    closing: 'We only access this data after the user grants explicit permission.',
  },
  {
    title: '2. How We Use Information',
    paragraphs: [
      'We use the collected information to:',
    ],
    items: [
      'Provide and improve app functionality',
      'Enable features such as contact management and media uploads',
      'Store selected data securely on our servers',
    ],
    closing: 'We do not sell or share user data with third parties for marketing purposes.',
  },
  {
    title: '3. Data Storage and Security',
    paragraphs: [
      'User data may be stored on secure servers, including cloud services. We take reasonable measures to protect data from unauthorized access, loss, or misuse.',
    ],
  },
  {
    title: '4. User Control',
    paragraphs: [
      'Users can:',
    ],
    items: [
      'Grant or revoke permissions at any time through device settings',
      'Stop using the app to prevent further data collection',
    ],
  },
  {
    title: '5. Third-Party Services',
    paragraphs: [
      'The app may use third-party services (e.g. cloud storage providers) to store and process data.',
    ],
  },
  {
    title: '6. Changes to This Policy',
    paragraphs: [
      'We may update this Privacy Policy from time to time. Updates will be reflected within the app.',
    ],
  },
  {
    title: '7. Contact',
    paragraphs: [
      'If you have any questions, please contact us at:',
      'support@memberreward.com',
    ],
  },
];

const renderPrivacyPolicyHtml = () => {
  const renderedSections = PRIVACY_POLICY_SECTIONS.map((section) => {
    const paragraphs = (section.paragraphs || [])
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join('');

    const items = section.items?.length
      ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';

    const closing = section.closing
      ? `<p>${escapeHtml(section.closing)}</p>`
      : '';

    return `
      <section>
        <h2>${escapeHtml(section.title)}</h2>
        ${paragraphs}
        ${items}
        ${closing}
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy Policy | Member Reward</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --card: #ffffff;
        --text: #172033;
        --muted: #5f6b85;
        --accent: #2952ff;
        --border: #d9dfeb;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background:
          radial-gradient(circle at top right, rgba(41, 82, 255, 0.12), transparent 28%),
          linear-gradient(180deg, #f8faff 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 48px 20px 72px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 20px;
        box-shadow: 0 20px 48px rgba(25, 42, 89, 0.08);
        overflow: hidden;
      }

      header {
        padding: 36px 32px 24px;
        border-bottom: 1px solid var(--border);
      }

      .eyebrow {
        margin: 0 0 10px;
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--accent);
        font-weight: 700;
      }

      h1 {
        margin: 0;
        font-size: clamp(32px, 4vw, 44px);
        line-height: 1.05;
      }

      .intro {
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.7;
        max-width: 64ch;
      }

      .content {
        padding: 8px 32px 32px;
      }

      section {
        padding-top: 24px;
      }

      h2 {
        margin: 0 0 12px;
        font-size: 22px;
        line-height: 1.25;
      }

      p, li {
        font-size: 16px;
        line-height: 1.75;
        color: var(--text);
      }

      p {
        margin: 0 0 12px;
      }

      ul {
        margin: 0 0 12px 22px;
        padding: 0;
      }

      li + li {
        margin-top: 8px;
      }

      footer {
        padding: 0 32px 32px;
        color: var(--muted);
        font-size: 14px;
      }

      a {
        color: var(--accent);
      }

      @media (max-width: 640px) {
        header,
        .content,
        footer {
          padding-left: 20px;
          padding-right: 20px;
        }

        main {
          padding-top: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <article class="card">
        <header>
          <p class="eyebrow">Member Reward</p>
          <h1>Privacy Policy</h1>
          <p class="intro">
            This Privacy Policy describes how Member Reward ("we", "our", or "the app")
            collects, uses, and protects user information.
          </p>
        </header>
        <div class="content">
          ${renderedSections}
        </div>
        <footer>
          For support, email <a href="mailto:support@memberreward.com">support@memberreward.com</a>.
        </footer>
      </article>
    </main>
  </body>
</html>`;
};

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    attachTenantScopedContentManagerControllers(strapi);
    attachTenantScopedRelationControllers(strapi);
    attachTenantAdminPermissionExpansion(strapi);

    strapi.server.use(async (ctx, next) => {
      const adminUser = await getAdminRequestUser(ctx, strapi);
      if (!adminUser?.id) {
        return next();
      }

      const relationRequest = getContentManagerRelationParams(ctx.request.path || '');
      if (ctx.method === 'GET' && relationRequest?.targetField === 'tenant') {
        const { model, entityId, mode } = relationRequest;
        const supportedRelationModel = model === APP_USER_UID || model === CONTACT_UID;
        if (!supportedRelationModel) {
          return next();
        }

        const tenantContext = await getAdminTenantContext(strapi, adminUser);
        if (tenantContext.isSuperAdmin) {
          return next();
        }

        if (!tenantContext.tenantIds.length) {
          return ctx.forbidden('This admin user is not assigned to a tenant.');
        }

        if (mode === 'available') {
          const page = Math.max(1, Number(ctx.request.query?.page) || 1);
          const pageSize = Math.max(1, Math.min(100, Number(ctx.request.query?.pageSize) || 10));
          const start = (page - 1) * pageSize;
          const tenantResults = tenantContext.tenants
            .slice()
            .sort((left, right) => String(left?.name || left?.slug || '').localeCompare(String(right?.name || right?.slug || '')))
            .slice(start, start + pageSize)
            .map((tenant) => ({
              id: tenant.id,
              name: tenant.name || tenant.slug || String(tenant.id),
              slug: tenant.slug || null,
            }));

          ctx.body = {
            results: tenantResults,
            pagination: {
              page,
              pageSize,
              pageCount: Math.max(1, Math.ceil(tenantContext.tenants.length / pageSize)),
              total: tenantContext.tenants.length,
            },
          };
          return;
        }

        if (!entityId) {
          return ctx.badRequest('Entry id must be a valid number.');
        }

        const allowed = await Promise.all(
          tenantContext.tenantIds.map((tenantId) =>
            model === APP_USER_UID
              ? assertTenantScopeForUser(strapi, tenantId, entityId)
              : assertTenantScopeForContact(strapi, tenantId, entityId)
          )
        );

        const scopedEntity = allowed.find(Boolean);
        if (!scopedEntity) {
          return ctx.forbidden('This record is outside your tenants.');
        }

        const tenant = scopedEntity.tenant || null;
        ctx.body = {
          data: tenant
            ? {
                id: tenant.id,
                name: tenant.name || tenant.slug || String(tenant.id),
                slug: tenant.slug || null,
              }
            : null,
        };
        return;
      }

      const slug = getContentManagerSlug(ctx.request.path || '');
      if (!slug) {
        return next();
      }

      if ((ctx.method === 'POST' || ctx.method === 'PUT') && slug === APP_TENANT_UID) {
        stripManagedTenantFields(ctx, slug);
      }

      if (ctx.method === 'POST' && slug === APP_TENANT_ADMIN_UID) {
        const data = getRequestData(ctx);
        const tenantIds = resolveTenantAdminBulkTenantIds(data);
        const relationTenantIds = resolveTenantRelationIds(data?.tenant);

        if (!relationTenantIds.length && tenantIds.length > 0) {
          setRequestData(ctx, {
            ...data,
            qr_code_url: null,
            tenant: {
              connect: tenantIds.map((id) => ({ id })),
            },
          });
        }

        strapi.log.info(
          `[tenant-admin-create] bodyTenant=${JSON.stringify(data?.tenant || null)} qrCodeUrl=${JSON.stringify(data?.qr_code_url || null)} resolvedTenantIds=${JSON.stringify(tenantIds)}`
        );
        if (tenantIds.length > 1) {
          const createPayload = getRequestData(ctx);
          if (!createPayload || typeof createPayload !== 'object') {
            return ctx.badRequest('Tenant Admin bulk creation requires a valid request body.');
          }

          strapi.log.info(
            `[tenant-admin-bulk-create] admin_email="${String(createPayload.admin_email || '').trim()}" tenantIds=${JSON.stringify(tenantIds)}`
          );

          const createdRecords = [];
          for (const tenantId of tenantIds) {
            const nextData = {
              ...createPayload,
              qr_code_url: null,
              tenant: {
                connect: [{ id: tenantId }],
              },
            };

            const created = await strapi.entityService.create(APP_TENANT_ADMIN_UID, {
              data: nextData,
              populate: {
                tenant: {
                  fields: ['id', 'name', 'slug'],
                },
              },
            });
            createdRecords.push(created);
            strapi.log.info(
              `[tenant-admin-bulk-create] created record id=${created?.id || 'unknown'} for tenantId=${tenantId}`
            );
          }

          strapi.log.info(
            `[tenant-admin-bulk-create] completed createdCount=${createdRecords.length}`
          );
          ctx.body = createdRecords[0] || null;
          return;
        }
      }

      const tenantContext = await getAdminTenantContext(strapi, adminUser);
      if (tenantContext.isSuperAdmin) {
        return next();
      }

      if (!tenantContext.tenantIds.length) {
        return ctx.forbidden('This admin user is not assigned to a tenant.');
      }

      if (slug === APP_TENANT_ADMIN_UID) {
        if (ctx.method === 'GET') {
          const entityId = getContentManagerEntityId(ctx.request.path || '');
          if (!entityId) {
            ctx.body = await buildScopedTenantAdminListResponse({
              strapi,
              adminUserId: adminUser.id,
              tenantIds: tenantContext.tenantIds,
              requestQuery: ctx.request.query,
            });
            return;
          }

          const tenantAdminRecord = await findScopedTenantAdminRecord({
            strapi,
            adminUserId: adminUser.id,
            tenantIds: tenantContext.tenantIds,
            entityId,
          });

          if (!tenantAdminRecord) {
            return ctx.forbidden('This tenant admin record is outside your scope.');
          }

          ctx.body = tenantAdminRecord;
          return;
        }

        return ctx.forbidden('Tenant admin users cannot modify tenant admin mappings.');
      }

      if (slug === APP_TENANT_UID) {
        const entityId = getContentManagerEntityId(ctx.request.path || '');

        if (ctx.method === 'GET' && !entityId) {
          withAdminTenantFilter(ctx, tenantContext.tenantIds);
          return next();
        }

        if (ctx.method === 'GET' && entityId) {
          if (!tenantContext.tenantIds.includes(entityId)) {
            return ctx.forbidden('This tenant is outside your scope.');
          }
          return next();
        }

        return ctx.forbidden('Tenant admin users cannot modify tenant configuration.');
      }

      if (slug !== APP_USER_UID && slug !== CONTACT_UID) {
        return next();
      }

      const entityId = getContentManagerEntityId(ctx.request.path || '');
      if (ctx.method === 'GET' && !entityId) {
        withAdminTenantFilter(ctx, tenantContext.tenantIds);
        return next();
      }

      if (ctx.method === 'POST') {
        if (!enforceTenantOnAdminBody(ctx, tenantContext, slug)) {
          return ctx.forbidden('This admin user cannot create records outside assigned tenants.');
        }
        return next();
      }

      if (entityId && (ctx.method === 'GET' || ctx.method === 'DELETE' || ctx.method === 'PUT')) {
        const allowed = await Promise.all(
          tenantContext.tenantIds.map((tenantId) =>
            slug === APP_USER_UID
              ? assertTenantScopeForUser(strapi, tenantId, entityId)
              : assertTenantScopeForContact(strapi, tenantId, entityId)
          )
        );

        if (!allowed.some(Boolean)) {
          return ctx.forbidden('This record is outside your tenants.');
        }
      }

      if (ctx.method === 'PUT') {
        if (!enforceTenantOnAdminBody(ctx, tenantContext, slug)) {
          return ctx.forbidden('This admin user cannot update records outside assigned tenants.');
        }
      }

      return next();
    });

    strapi.server.routes([
      {
        method: 'GET',
        path: '/privacy_policy',
        handler: async (ctx) => {
          ctx.type = 'text/html; charset=utf-8';
          ctx.body = renderPrivacyPolicyHtml();
        },
        config: {
          auth: false,
        },
      },
      {
        method: 'GET',
        path: '/qr-code.svg',
        handler: async (ctx) => {
          const value = String(ctx.query?.value || '').trim();
          if (!value) {
            return ctx.badRequest('A QR code value is required.');
          }

          const svg = await QRCode.toString(value, {
            type: 'svg',
            margin: 1,
            width: 256,
            color: {
              dark: '#111827',
              light: '#FFFFFF',
            },
          });

          ctx.type = 'image/svg+xml';
          ctx.body = svg;
        },
        config: {
          auth: false,
        },
      },
      {
        method: 'GET',
        path: '/qr-install',
        handler: async (ctx) => {
          const qrToken = String(ctx.query?.qrToken || ctx.query?.token || '').trim();
          const tenantCode = String(
            ctx.query?.tenantCode || ctx.query?.tenant || ctx.query?.tenantSlug || ''
          ).trim();
          const referralCode = String(ctx.query?.referralCode || '').trim();
          const isAndroidRequest = /Android/i.test(String(ctx.get('user-agent') || ''));

          if (!tenantCode && !qrToken) {
            ctx.type = 'text/html; charset=utf-8';
            ctx.status = 400;
            ctx.body = renderQrLandingHtml({
              tenant: {
                app_display_name: 'Member Reward',
                primary_color: '#2F6BFF',
                android_apk_url: '',
              },
              tenantCode: '',
              qrToken: '',
              referralCode,
              qrCodeUrl: '',
              isAndroidRequest,
            });
            return;
          }

          const launchContext = qrToken
            ? await findTenantLaunchByQrToken(strapi, qrToken)
            : null;
          const tenant = launchContext?.tenant || (await strapi.entityService.findMany(APP_TENANT_UID, {
            filters: {
              slug: {
                $eq: tenantCode,
              },
              status: {
                $ne: 'inactive',
              },
            },
            fields: [
              'id',
              'name',
              'slug',
              'status',
              'app_display_name',
              'primary_color',
              'android_apk_url',
              'qr_code_url',
            ],
            limit: 1,
          }))[0];

          if (!tenant) {
            strapi.log.warn(
              `[qr-install] Missing tenant for tenantCode="${tenantCode}" qrTokenPresent=${Boolean(qrToken)} referralCode="${referralCode}"`
            );
            ctx.type = 'text/html; charset=utf-8';
            ctx.status = 404;
            ctx.body = renderQrLandingHtml({
              tenant: {
                app_display_name: 'Member Reward',
                primary_color: '#2F6BFF',
                android_apk_url: '',
              },
              tenantCode,
              qrToken,
              referralCode,
              qrCodeUrl: '',
              isAndroidRequest,
            });
            return;
          }

          strapi.log.info(
            `[qr-install] tenant="${tenant.slug}" sharedDeepLinkScheme="${getSharedDeepLinkScheme()}" apkUrlPresent=${Boolean(
              ensureAbsoluteUrl(tenant.android_apk_url)
            )} qrCodeUrl="${launchContext?.tenantAdmin?.qr_code_url || tenant.qr_code_url || ''}" qrTokenPresent=${Boolean(
              qrToken
            )} referralCode="${referralCode}"`
          );

          ctx.type = 'text/html; charset=utf-8';
          ctx.body = renderQrLandingHtml({
            tenant,
            tenantCode: tenant.slug || tenantCode,
            qrToken: qrToken || launchContext?.tenantAdmin?.qr_token || '',
            referralCode,
            qrCodeUrl: launchContext?.tenantAdmin?.qr_code_url || tenant.qr_code_url || ctx.request.href,
            isAndroidRequest,
          });
        },
        config: {
          auth: false,
        },
      },
      {
        method: 'GET',
        path: '/api/app-bootstrap',
        handler: async (ctx) => {
          const qrToken = String(ctx.query?.qrToken || ctx.query?.token || '').trim();
          if (!qrToken) {
            return ctx.badRequest('A qrToken query parameter is required.');
          }

          const launchContext = await findTenantLaunchByQrToken(strapi, qrToken);
          if (!launchContext?.tenant) {
            return ctx.forbidden('Invalid tenant QR token.');
          }

          const tenant = launchContext.tenant;
          const tenantAdmin = launchContext.tenantAdmin;

          ctx.body = {
            data: {
              tenantCode: tenant.slug,
              tenantName: tenantAdmin?.tenant_name || tenant.app_display_name || tenant.name,
              appDisplayName: tenant.app_display_name || tenant.name,
              primaryColor: tenant.primary_color || null,
              supportEmail: tenant.support_email || null,
              deepLinkScheme: getSharedDeepLinkScheme(),
              androidApplicationId: getSharedAndroidApplicationId(),
              qrCodeUrl: tenantAdmin?.qr_code_url || null,
            },
          };
        },
        config: {
          auth: false,
        },
      },
    ]);

    strapi.server.routes({
      type: 'admin',
      routes: [
        {
          method: 'GET',
          path: '/twilio/voice/token',
          handler: async (ctx) => {
            const adminUser = await getAdminRequestUser(ctx, strapi);
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }

            try {
              ctx.body = {
                data: createVoiceAccessToken(adminUser),
              };
            } catch (error) {
              strapi.log.error(`[twilio-voice] ${error.message}`);
              return ctx.internalServerError(error.message);
            }
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'POST',
          path: '/tenant-api-key/:id/rotate',
          handler: async (ctx) => {
            const tenantId = parsePositiveInt(ctx.params.id);
            if (!tenantId) {
              return ctx.badRequest('Tenant id must be a valid number.');
            }

            const tenantContext = await getAdminTenantContext(strapi, await getAdminRequestUser(ctx, strapi));
            if (!tenantContext.isAdmin) {
              return ctx.forbidden('Only authenticated admins can rotate tenant API keys.');
            }

            if (!tenantContext.isSuperAdmin && !tenantContext.tenantIds.includes(tenantId)) {
              return ctx.forbidden('You can only rotate API keys for tenants you manage.');
            }

            const tenant = await strapi.entityService.findOne(APP_TENANT_UID, tenantId, {
              fields: ['id', 'name', 'slug', 'app_api_key', 'status', 'android_application_id'],
            });
            if (!tenant) {
              return ctx.notFound('Tenant not found.');
            }

            const nextKey = generateTenantApiKey(tenant);
            const updatedTenant = await strapi.entityService.update(APP_TENANT_UID, tenantId, {
              data: {
                app_api_key: nextKey,
              },
              fields: ['id', 'name', 'slug', 'app_api_key', 'status', 'android_application_id'],
            });

            ctx.body = {
              data: {
                id: updatedTenant.id,
                name: updatedTenant.name,
                slug: updatedTenant.slug,
                status: updatedTenant.status,
                appApiKey: updatedTenant.app_api_key,
                androidApplicationId: updatedTenant.android_application_id,
              },
            };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'GET',
          path: '/app-user-gallery/:id',
          handler: async (ctx) => {
            const userId = parsePositiveInt(ctx.params.id);
            if (!userId) {
              return ctx.badRequest('User id must be a valid number.');
            }

            const bucket = process.env.S3_BUCKET_NAME;
            const region = process.env.AWS_REGION;
            const prefixBase = process.env.S3_IMAGES_PREFIX || 'users';
            const expiresIn = parsePositiveInt(process.env.S3_PRESIGN_EXPIRES_IN) || 900;

            if (!bucket || !region) {
              return ctx.internalServerError('S3 configuration missing: S3_BUCKET_NAME or AWS_REGION.');
            }

            const tenantContext = await getAdminTenantContext(strapi, await getAdminRequestUser(ctx, strapi));
            let user;

            if (tenantContext.isSuperAdmin) {
              user = await strapi.entityService.findOne(APP_USER_UID, userId, {
                fields: ['id'],
                populate: {
                  tenant: {
                    fields: ['id', 'slug', 'name'],
                  },
                },
              });
            } else {
              const allowedUsers = await Promise.all(
                tenantContext.tenantIds.map((tenantId) => assertTenantScopeForUser(strapi, tenantId, userId))
              );
              user = allowedUsers.find(Boolean) || null;
            }

            if (!user) {
              return ctx.forbidden('This user is outside your tenant.');
            }

            const s3Client = new AWS.S3({
              region,
              signatureVersion: 'v4',
            });

            const prefix = `${buildTenantUserImagePrefix(user.tenant, userId, prefixBase)}/`;
            const listed = await s3Client.listObjectsV2({
              Bucket: bucket,
              Prefix: prefix,
              MaxKeys: 100,
            }).promise();

            const items = await Promise.all(
              (listed.Contents || [])
                .filter((item) => item.Key)
                .sort((left, right) => {
                  const leftTime = new Date(left.LastModified || 0).getTime();
                  const rightTime = new Date(right.LastModified || 0).getTime();
                  return rightTime - leftTime;
                })
                .map(async (item) => {
                  const signedUrl = await s3Client.getSignedUrlPromise('getObject', {
                    Bucket: bucket,
                    Key: item.Key,
                    Expires: expiresIn,
                  });

                  return {
                    key: item.Key,
                    size: item.Size || 0,
                    lastModified: item.LastModified || null,
                    signedUrl,
                    objectUrl: buildS3ObjectUrl(bucket, region, item.Key),
                  };
                })
            );

            ctx.body = {
              data: items,
              meta: {
                bucket,
                region,
                prefix,
                total: items.length,
                expiresIn,
              },
            };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
      ],
    });
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    await syncTenantAdminListConfiguration(strapi);
  },
};
