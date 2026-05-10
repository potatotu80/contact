'use strict';

const { errors } = require('@strapi/utils');
const { ADMIN_USER_UID, parsePositiveInt } = require('../../../../utils/tenant-access');
const { ValidationError } = errors;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const findAdminUserByEmail = async (email) => {
  const trimmedEmail = String(email || '').trim();
  if (!trimmedEmail) {
    return null;
  }

  const exactMatch = await strapi.query(ADMIN_USER_UID).findOne({
    where: {
      email: trimmedEmail,
    },
    select: ['id', 'email'],
  });
  if (exactMatch) {
    return exactMatch;
  }

  const normalized = normalizeEmail(trimmedEmail);
  const candidates = await strapi.db.query(ADMIN_USER_UID).findMany({
    select: ['id', 'email'],
    limit: 200,
  });

  return candidates.find((entry) => normalizeEmail(entry.email) === normalized) || null;
};

const syncAdminSnapshot = async (event) => {
  const data = event.params?.data;
  if (!data) {
    return;
  }

  const adminEmail = String(data.admin_email || '').trim();
  const adminUserId = parsePositiveInt(data.admin_user_id);
  const existingRecordId = parsePositiveInt(event.params?.where?.id);

  let adminUser = null;

  if (adminEmail) {
    adminUser = await findAdminUserByEmail(adminEmail);
  }

  if (!adminUser && adminUserId) {
    adminUser = await strapi.db.query(ADMIN_USER_UID).findOne({
      where: {
        id: adminUserId,
      },
      select: ['id', 'email'],
    });
  }

  if (!adminUser && existingRecordId) {
    const existingRecord = await strapi.db.query('api::tenant-admin.tenant-admin').findOne({
      where: {
        id: existingRecordId,
      },
      select: ['admin_user_id', 'admin_email'],
    });

    const existingAdminEmail = String(existingRecord?.admin_email || '').trim();
    const existingAdminUserId = parsePositiveInt(existingRecord?.admin_user_id);

    if (existingAdminEmail) {
      adminUser = await findAdminUserByEmail(existingAdminEmail);
    }

    if (!adminUser && existingAdminUserId) {
      adminUser = await strapi.db.query(ADMIN_USER_UID).findOne({
        where: {
          id: existingAdminUserId,
        },
        select: ['id', 'email'],
      });
    }
  }

  if (!adminUser) {
    throw new ValidationError('Tenant Admin requires a valid admin email or admin user id.');
  }

  data.admin_user_id = adminUser.id;
  data.admin_email = adminUser.email || null;
};

module.exports = {
  async beforeCreate(event) {
    await syncAdminSnapshot(event);
  },

  async beforeUpdate(event) {
    await syncAdminSnapshot(event);
  },
};
