'use strict';

const APP_USER_UID = 'api::app-user.app-user';

const extractUserId = (userValue) => {
  if (!userValue) return null;

  if (typeof userValue === 'number') return userValue;
  if (typeof userValue === 'string') {
    const parsed = Number(userValue);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (typeof userValue === 'object') {
    if (typeof userValue.id === 'number') return userValue.id;

    if (Array.isArray(userValue.connect) && userValue.connect[0]?.id) {
      return Number(userValue.connect[0].id);
    }

    if (Array.isArray(userValue.set) && userValue.set[0]?.id) {
      return Number(userValue.set[0].id);
    }
  }

  return null;
};

const syncUserSnapshot = async (event) => {
  const data = event.params?.data;
  if (!data) return;

  const userId = extractUserId(data.user);
  if (!userId) return;

  const appUser = await strapi.entityService.findOne(APP_USER_UID, userId, {
    fields: ['email', 'phone'],
  });

  if (!appUser) return;

  data.user_email = appUser.email || null;
  data.user_phone = appUser.phone || null;
};

module.exports = {
  async beforeCreate(event) {
    await syncUserSnapshot(event);
  },

  async beforeUpdate(event) {
    await syncUserSnapshot(event);
  },
};
