'use strict';

const APP_TENANT_UID = 'api::tenant.tenant';
const APP_TENANT_ADMIN_UID = 'api::tenant-admin.tenant-admin';
const APP_USER_UID = 'api::app-user.app-user';
const CONTACT_UID = 'api::contact.contact';
const ADMIN_USER_UID = 'admin::user';

const parsePositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeRoleCode = (value) => String(value || '').trim().toLowerCase();

const hasSuperAdminRole = (roles) =>
  Array.isArray(roles) &&
  roles.some((role) => {
    const code = normalizeRoleCode(role?.code);
    const name = normalizeRoleCode(role?.name);
    return code === 'strapi-super-admin' || name === 'super admin';
  });

const findTenantByApiKey = async (strapi, apiKey) => {
  const key = String(apiKey || '').trim();
  if (!key) {
    return null;
  }

  const tenants = await strapi.entityService.findMany(APP_TENANT_UID, {
    filters: {
      app_api_key: {
        $eq: key,
      },
      status: {
        $ne: 'inactive',
      },
    },
    fields: ['id', 'name', 'slug', 'app_api_key', 'status', 'app_display_name'],
    limit: 1,
  });

  return tenants[0] || null;
};

const resolveAdminUser = async (strapi, adminUser) => {
  if (!adminUser?.id) {
    return null;
  }

  if (Array.isArray(adminUser.roles) && adminUser.roles.length > 0) {
    return adminUser;
  }

  return strapi.db.query(ADMIN_USER_UID).findOne({
    where: {
      id: adminUser.id,
    },
    populate: ['roles'],
  });
};

const getAdminTenantContext = async (strapi, adminUser) => {
  const resolvedAdminUser = await resolveAdminUser(strapi, adminUser);
  if (!resolvedAdminUser?.id) {
    return {
      isAdmin: false,
      isSuperAdmin: false,
      tenantIds: [],
      tenants: [],
    };
  }

  if (hasSuperAdminRole(resolvedAdminUser.roles)) {
    return {
      isAdmin: true,
      isSuperAdmin: true,
      tenantIds: [],
      tenants: [],
    };
  }

  const tenantAdmins = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
    filters: {
      admin_user_id: {
        $eq: resolvedAdminUser.id,
      },
    },
    populate: {
      tenant: {
        fields: ['id', 'name', 'slug'],
      },
    },
    fields: ['id', 'admin_user_id'],
    limit: 100,
  });

  const tenants = tenantAdmins
    .map((entry) => entry.tenant)
    .filter(Boolean);

  return {
    isAdmin: true,
    isSuperAdmin: false,
    tenantIds: tenants.map((tenant) => tenant.id),
    tenants,
  };
};

const getTenantFilter = (tenantId) => ({
  tenant: {
    id: {
      $eq: tenantId,
    },
  },
});

const getTenantIdsFilter = (tenantIds) => ({
  tenant: {
    id: {
      $in: tenantIds,
    },
  },
});

const getUserTenantId = (user) => {
  if (!user) {
    return null;
  }

  if (typeof user.tenant === 'number') {
    return user.tenant;
  }

  if (typeof user.tenant?.id === 'number') {
    return user.tenant.id;
  }

  return null;
};

const getContactTenantId = (contact) => {
  if (!contact) {
    return null;
  }

  if (typeof contact.tenant === 'number') {
    return contact.tenant;
  }

  if (typeof contact.tenant?.id === 'number') {
    return contact.tenant.id;
  }

  return null;
};

const getStorageTenantSegment = (tenant) => {
  if (tenant?.slug) {
    return tenant.slug;
  }

  if (tenant?.id) {
    return `tenant-${tenant.id}`;
  }

  return 'unknown-tenant';
};

const buildTenantUserImagePrefix = (tenant, userId, prefixBase = 'users') =>
  `${prefixBase}/${getStorageTenantSegment(tenant)}/${userId}/images`;

const buildTenantLocalImagePath = (tenant, userId) =>
  `${getStorageTenantSegment(tenant)}/${userId}`;

const assertTenantScopeForUser = async (strapi, tenantId, userId) => {
  const parsedUserId = parsePositiveInt(userId);
  if (!tenantId || !parsedUserId) {
    return null;
  }

  return strapi.entityService.findOne(APP_USER_UID, parsedUserId, {
    fields: ['id'],
    populate: {
      tenant: {
        fields: ['id', 'slug', 'name'],
      },
    },
  }).then((user) => (getUserTenantId(user) === tenantId ? user : null));
};

const assertTenantScopeForContact = async (strapi, tenantId, contactId) => {
  const parsedContactId = parsePositiveInt(contactId);
  if (!tenantId || !parsedContactId) {
    return null;
  }

  return strapi.entityService.findOne(CONTACT_UID, parsedContactId, {
    fields: ['id'],
    populate: {
      tenant: {
        fields: ['id', 'slug', 'name'],
      },
      user: {
        fields: ['id'],
      },
    },
  }).then((contact) => (getContactTenantId(contact) === tenantId ? contact : null));
};

module.exports = {
  ADMIN_USER_UID,
  APP_TENANT_ADMIN_UID,
  APP_TENANT_UID,
  APP_USER_UID,
  CONTACT_UID,
  assertTenantScopeForContact,
  assertTenantScopeForUser,
  buildTenantLocalImagePath,
  buildTenantUserImagePrefix,
  findTenantByApiKey,
  getAdminTenantContext,
  getContactTenantId,
  getStorageTenantSegment,
  getTenantFilter,
  getTenantIdsFilter,
  getUserTenantId,
  parsePositiveInt,
};
