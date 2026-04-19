import React, { useMemo, useState } from 'react';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { ExternalLink } from '@strapi/icons';
import { useCMEditViewDataManager, useFetchClient } from '@strapi/helper-plugin';

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

const AppUserPanel = () => {
  const { slug, initialData } = useCMEditViewDataManager();
  const [isDeleting, setIsDeleting] = useState(false);
  const { del } = useFetchClient();

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

  const clearUser = async () => {
    if (!userId || isDeleting) return;

    const confirmed = window.confirm(
      'Clear this User? This will also delete all Contacts for the user, the local profile image, and all S3 gallery images under this user.'
    );
    if (!confirmed) return;

    try {
      setIsDeleting(true);
      await del(`/content-manager/collection-types/${APP_USER_UID}/${userId}`);
      window.location.assign(buildCollectionTypeListUrl(APP_USER_UID));
    } catch (error) {
      const message = error?.message || 'Failed to clear User.';
      window.alert(message);
    } finally {
      setIsDeleting(false);
    }
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

        <Button
          variant="danger-light"
          size="S"
          onClick={clearUser}
          disabled={!userId || isDeleting}
          fullWidth
        >
          {isDeleting ? 'Clearing User...' : 'Clear User'}
        </Button>

        <Typography variant="omega" textColor="neutral500">
          Opens Contacts filtered by this user, the user's S3 image folder, or clears the user and related data.
        </Typography>
      </Flex>
    </Box>
  );
};

const ContactPanel = () => {
  const { slug, initialData } = useCMEditViewDataManager();
  const [isDeleting, setIsDeleting] = useState(false);
  const { del } = useFetchClient();

  const isContact = slug === CONTACT_UID;
  const contactId = initialData?.id;

  if (!isContact) return null;

  const clearContact = async () => {
    if (!contactId || isDeleting) return;

    const confirmed = window.confirm('Clear this Contact?');
    if (!confirmed) return;

    try {
      setIsDeleting(true);
      await del(`/content-manager/collection-types/${CONTACT_UID}/${contactId}`);
      window.location.assign(buildCollectionTypeListUrl(CONTACT_UID));
    } catch (error) {
      const message = error?.message || 'Failed to clear Contact.';
      window.alert(message);
    } finally {
      setIsDeleting(false);
    }
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
          Contact Actions
        </Typography>

        <Button
          variant="danger-light"
          size="S"
          onClick={clearContact}
          disabled={!contactId || isDeleting}
          fullWidth
        >
          {isDeleting ? 'Clearing Contact...' : 'Clear Contact'}
        </Button>

        <Typography variant="omega" textColor="neutral500">
          Removes this Contact entry from the database.
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
    name: 'app-user-panel',
    Component: AppUserPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'contact-panel',
    Component: ContactPanel,
  });
};

export default {
  config,
  bootstrap,
};
