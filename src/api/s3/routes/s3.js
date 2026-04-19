'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/s3/presign',
      handler: 's3.presign',
      config: {
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
  ],
};
