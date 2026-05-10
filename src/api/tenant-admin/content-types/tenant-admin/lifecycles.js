'use strict';

const { errors } = require('@strapi/utils');
const { ADMIN_USER_UID, parsePositiveInt } = require('../../../../utils/tenant-access');
const { ValidationError } = errors;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const syncAdminSnapshot = async (event) => {
  const data = event.params?.data;
  if (!data) {
    return;
  }

  const adminEmail = normalizeEmail(data.admin_email);
  const adminUserId = parsePositiveInt(data.admin_user_id);

  let adminUser = null;

  if (adminEmail) {
    adminUser = await strapi.db.query(ADMIN_USER_UID).findOne({
      where: {
        email: adminEmail,
      },
      select: ['id', 'email'],
    });
  }

  if (!adminUser && adminUserId) {
    adminUser = await strapi.db.query(ADMIN_USER_UID).findOne({
      where: {
        id: adminUserId,
      },
      select: ['id', 'email'],
    });
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
