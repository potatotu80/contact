import React, { useMemo } from 'react';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { ExternalLink } from '@strapi/icons';
import { useCMEditViewDataManager } from '@strapi/helper-plugin';

const APP_USER_UID = 'api::app-user.app-user';
const S3_BUCKET = process.env.STRAPI_ADMIN_S3_BUCKET || '';
const S3_REGION = process.env.STRAPI_ADMIN_S3_REGION || '';
const S3_IMAGES_PREFIX = process.env.STRAPI_ADMIN_S3_IMAGES_PREFIX || 'users';

const formatDateTime = (value) => {
  if (!value) return 'Not available';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return date.toLocaleString();
};

const buildS3ConsoleFolderUrl = (userId) => {
  if (!userId || !S3_BUCKET || !S3_REGION) return null;

  const prefix = `${S3_IMAGES_PREFIX}/${userId}/images/`;
  return (
    `https://s3.console.aws.amazon.com/s3/buckets/${S3_BUCKET}` +
    `?region=${encodeURIComponent(S3_REGION)}` +
    `&prefix=${encodeURIComponent(prefix)}` +
    '&showversions=false'
  );
};

const AppUserContactsPanel = () => {
  const { slug, initialData } = useCMEditViewDataManager();

  const isAppUser = slug === APP_USER_UID;
  const userId = initialData?.id;

  const createdAtText = useMemo(
    () => formatDateTime(initialData?.createdAt),
    [initialData?.createdAt]
  );
  const updatedAtText = useMemo(
    () => formatDateTime(initialData?.updatedAt),
    [initialData?.updatedAt]
  );
  const userImagesUrl = useMemo(() => buildS3ConsoleFolderUrl(userId), [userId]);

  if (!isAppUser) return null;

  const openUserContacts = () => {
    if (!userId) return;

    const url = new URL(
      '/admin/content-manager/collectionType/api::contact.contact',
      window.location.origin
    );
    url.searchParams.set('page', '1');
    url.searchParams.set('pageSize', '25');
    url.searchParams.set('sort', 'name:asc');
    url.searchParams.set('filters[user][id][$eq]', String(userId));

    window.location.assign(url.toString());
  };

  const openUserImages = () => {
    if (!userImagesUrl) return;
    window.open(userImagesUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          User Timeline
        </Typography>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Created At
          </Typography>
          <Typography variant="pi">{createdAtText}</Typography>
        </Box>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Updated At
          </Typography>
          <Typography variant="pi">{updatedAtText}</Typography>
        </Box>

        <Button
          variant="secondary"
          size="S"
          endIcon={<ExternalLink />}
          onClick={openUserContacts}
          disabled={!userId}
          fullWidth
        >
          Open User Contacts
        </Button>

        <Button
          variant="secondary"
          size="S"
          endIcon={<ExternalLink />}
          onClick={openUserImages}
          disabled={!userImagesUrl}
          fullWidth
        >
          Open User Images (S3)
        </Button>

        <Typography variant="omega" textColor="neutral500">
          Opens Contacts filtered by this user and the user's S3 image folder.
        </Typography>
      </Flex>
    </Box>
  );
};

const config = {
  locales: [],
};

const bootstrap = (app) => {
  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'app-user-contacts-panel',
    Component: AppUserContactsPanel,
  });
};

export default {
  config,
  bootstrap,
};
