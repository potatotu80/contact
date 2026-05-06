'use strict';

const { ADMIN_USER_UID, parsePositiveInt } = require('../../../../utils/tenant-access');

const syncAdminSnapshot = async (event) => {
  const data = event.params?.data;
  if (!data) {
    return;
  }

  const adminUserId = parsePositiveInt(data.admin_user_id);
  if (!adminUserId) {
    return;
  }

  const adminUser = await strapi.db.query(ADMIN_USER_UID).findOne({
    where: {
      id: adminUserId,
    },
    select: ['id', 'email'],
  });

  if (!adminUser) {
    return;
  }

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
