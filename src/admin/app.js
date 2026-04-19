import React, { useMemo, useState } from 'react';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { ExternalLink } from '@strapi/icons';
import { useCMEditViewDataManager, useFetchClient, useNotification } from '@strapi/helper-plugin';
import { useRouteMatch } from 'react-router-dom';

const APP_USER_UID = 'api::app-user.app-user';
const CONTACT_UID = 'api::contact.contact';
const S3_BUCKET = process.env.STRAPI_ADMIN_S3_BUCKET || 'yengtesting';
const S3_REGION = process.env.STRAPI_ADMIN_S3_REGION || 'ap-southeast-1';
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

const buildCollectionTypeListUrl = (slug, queryParams = {}) => {
  const url = new URL(
    `/admin/content-manager/collectionType/${slug}`,
    window.location.origin
  );

  Object.entries(queryParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
};

const fetchAllEntryIds = async (get, slug) => {
  const pageSize = 100;
  let page = 1;
  let pageCount = 1;
  const ids = [];

  do {
    const response = await get(`/content-manager/collection-types/${slug}`, {
      params: {
        page,
        pageSize,
      },
    });

    const items = response?.data?.results || response?.data || [];
    items.forEach((item) => {
      if (item?.id) {
        ids.push(item.id);
      }
    });

    const pagination = response?.pagination || response?.data?.pagination;
    pageCount = pagination?.pageCount || 1;
    page += 1;
  } while (page <= pageCount);

  return ids;
};

const AppUserPanel = () => {
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

    window.location.assign(
      buildCollectionTypeListUrl(CONTACT_UID, {
        page: '1',
        pageSize: '25',
        sort: 'name:asc',
        'filters[user][id][$eq]': String(userId),
      })
    );
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

const BulkClearActions = () => {
  const [isClearing, setIsClearing] = useState(false);
  const { get, del } = useFetchClient();
  const toggleNotification = useNotification();
  const userMatch = useRouteMatch('/content-manager/collectionType/api::app-user.app-user');
  const contactMatch = useRouteMatch('/content-manager/collectionType/api::contact.contact');

  const slug = userMatch ? APP_USER_UID : contactMatch ? CONTACT_UID : null;
  if (!slug) return null;

  const isUserList = slug === APP_USER_UID;
  const label = isUserList ? 'Clear All Users' : 'Clear All Contacts';
  const confirmText = isUserList
    ? 'Clear ALL Users? This will also delete all related Contacts, local profile images, and the users\' S3 gallery images.'
    : 'Clear ALL Contacts?';

  const clearAllEntries = async () => {
    if (isClearing) return;

    const confirmed = window.confirm(confirmText);
    if (!confirmed) return;

    try {
      setIsClearing(true);
      const ids = await fetchAllEntryIds(get, slug);

      for (const id of ids) {
        await del(`/content-manager/collection-types/${slug}/${id}`);
      }

      toggleNotification({
        type: 'success',
        message: `${label} completed.`,
      });
      window.location.assign(buildCollectionTypeListUrl(slug));
    } catch (error) {
      const message = error?.message || `Failed to run ${label}.`;
      toggleNotification({
        type: 'warning',
        message,
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Button
      variant="danger-light"
      size="S"
      onClick={clearAllEntries}
      disabled={isClearing}
    >
      {isClearing ? `${label}...` : label}
    </Button>
  );
};

const config = {
  locales: [],
};

const bootstrap = (app) => {
  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'app-user-panel',
    Component: AppUserPanel,
  });

  app.injectContentManagerComponent('listView', 'actions', {
    name: 'bulk-clear-actions',
    Component: BulkClearActions,
  });
};

export default {
  config,
  bootstrap,
};
