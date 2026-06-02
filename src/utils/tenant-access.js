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

const findTenantByReferralCode = async (strapi, referralCode) => {
  const code = String(referralCode || '').trim();
  if (!code) {
    return null;
  }

  const exactMatch = await strapi.entityService.findMany(APP_TENANT_UID, {
    filters: {
      status: {
        $ne: 'inactive',
      },
      $or: [
        {
          name: {
            $eq: code,
          },
        },
        {
          slug: {
            $eq: code,
          },
        },
        {
          app_display_name: {
            $eq: code,
          },
        },
      ],
    },
    fields: ['id', 'name', 'slug', 'app_api_key', 'status', 'app_display_name'],
    limit: 1,
  });

  return exactMatch[0] || null;
};

const findTenantLaunchByQrToken = async (strapi, qrToken) => {
  const token = String(qrToken || '').trim();
  if (!token) {
    return null;
  }

  const tenantAdmins = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
    filters: {
      qr_token: {
        $eq: token,
      },
      tenant: {
        status: {
          $ne: 'inactive',
        },
      },
    },
    fields: ['id', 'admin_email', 'tenant_name', 'qr_token', 'qr_code_url'],
    populate: {
      tenant: {
        fields: [
          'id',
          'name',
          'slug',
          'app_api_key',
          'status',
          'app_display_name',
          'primary_color',
          'support_email',
          'android_apk_url',
        ],
      },
    },
    limit: 1,
  });

  const tenantAdmin = tenantAdmins[0] || null;
  if (!tenantAdmin?.tenant) {
    return null;
  }

  return {
    tenant: tenantAdmin.tenant,
    tenantAdmin: {
      id: tenantAdmin.id,
      admin_email: tenantAdmin.admin_email || null,
      tenant_name: tenantAdmin.tenant_name || null,
      qr_token: tenantAdmin.qr_token || token,
      qr_code_url: tenantAdmin.qr_code_url || null,
    },
  };
};

const resolveAdminUser = async (strapi, adminUser) => {
  if (!adminUser?.id) {
    return null;
  }

  return strapi.query(ADMIN_USER_UID).findOne({
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
      tenantAdminIds: [],
      tenantAdminEmails: [],
      tenantAdminNames: [],
      adminEmail: null,
      tenants: [],
    };
  }

  const roleServiceHasSuperAdminRole = strapi.admin?.services?.role?.hasSuperAdminRole;
  const isSuperAdmin = typeof roleServiceHasSuperAdminRole === 'function'
    ? roleServiceHasSuperAdminRole(resolvedAdminUser)
    : Array.isArray(resolvedAdminUser.roles) && resolvedAdminUser.roles.some((role) => role?.code === 'strapi-super-admin');

  if (isSuperAdmin) {
    return {
      isAdmin: true,
      isSuperAdmin: true,
      tenantIds: [],
      tenantAdminIds: [],
      tenantAdminEmails: [],
      tenantAdminNames: [],
      adminEmail: String(resolvedAdminUser.email || '').trim().toLowerCase() || null,
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
    fields: ['id', 'admin_user_id', 'admin_email', 'tenant_name'],
    limit: 100,
  });

  const tenants = tenantAdmins
    .map((entry) => entry.tenant)
    .filter(Boolean);

  const tenantAdminIds = tenantAdmins
    .map((entry) => parsePositiveInt(entry.id))
    .filter(Boolean);
  const tenantAdminEmails = [...new Set(
    tenantAdmins
      .map((entry) => String(entry.admin_email || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  const tenantAdminNames = [...new Set(
    tenantAdmins
      .map((entry) => String(entry.tenant_name || '').trim())
      .filter(Boolean)
  )];

  return {
    isAdmin: true,
    isSuperAdmin: false,
    tenantIds: tenants.map((tenant) => tenant.id),
    tenantAdminIds,
    tenantAdminEmails,
    tenantAdminNames,
    adminEmail: String(resolvedAdminUser.email || '').trim().toLowerCase() || null,
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

  const users = await strapi.entityService.findMany(APP_USER_UID, {
    filters: {
      id: {
        $eq: parsedUserId,
      },
      tenant: {
        id: {
          $eq: tenantId,
        },
      },
    },
    fields: ['id'],
    populate: {
      tenant: {
        fields: ['id', 'slug', 'name'],
      },
    },
    limit: 1,
  });

  return users[0] || null;
};

const assertTenantScopeForContact = async (strapi, tenantId, contactId) => {
  const parsedContactId = parsePositiveInt(contactId);
  if (!tenantId || !parsedContactId) {
    return null;
  }

  const contacts = await strapi.entityService.findMany(CONTACT_UID, {
    filters: {
      id: {
        $eq: parsedContactId,
      },
      tenant: {
        id: {
          $eq: tenantId,
        },
      },
    },
    fields: ['id'],
    populate: {
      tenant: {
        fields: ['id', 'slug', 'name'],
      },
      user: {
        fields: ['id'],
      },
    },
    limit: 1,
  });

  return contacts[0] || null;
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
  findTenantByReferralCode,
  findTenantLaunchByQrToken,
  getAdminTenantContext,
  getContactTenantId,
  getStorageTenantSegment,
  getTenantFilter,
  getTenantIdsFilter,
  getUserTenantId,
  parsePositiveInt,
};

