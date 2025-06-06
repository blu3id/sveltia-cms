import { stripTags } from '@sveltia/utils/string';
import { get } from 'svelte/store';
import { siteConfig } from '$lib/services/config';
import { getCollection } from '$lib/services/contents/collection';
import { entryDraft, i18nAutoDupEnabled } from '$lib/services/contents/draft';
import { restoreBackupIfNeeded } from '$lib/services/contents/draft/backup';
import { showDuplicateToast } from '$lib/services/contents/draft/editor';
import { getFieldConfig, isFieldRequired } from '$lib/services/contents/entry/fields';
import { getDefaultValue as getDefaultCodeValue } from '$lib/services/contents/widgets/code/helper';
import { getDefaultValue as getDefaultDateTimeValue } from '$lib/services/contents/widgets/date-time/helper';
import { getDefaultValue as getDefaultHiddenValue } from '$lib/services/contents/widgets/hidden/helper';
import { getDefaultValue as getDefaultKvValue } from '$lib/services/contents/widgets/key-value/helper';
import { getDefaultValue as getDefaultUuidValue } from '$lib/services/contents/widgets/uuid/helper';

/**
 * @import {
 * EntryDraft,
 * FileCollection,
 * FlattenedEntryContent,
 * InternalCollection,
 * InternalCollectionFile,
 * InternalLocaleCode,
 * LocaleContentMap,
 * LocaleExpanderMap,
 * } from '$lib/types/private';
 * @import {
 * CodeField,
 * DateTimeField,
 * Field,
 * FieldKeyPath,
 * HiddenField,
 * KeyValueField,
 * ListField,
 * NumberField,
 * ObjectField,
 * RelationField,
 * SelectField,
 * UuidField,
 * } from '$lib/types/public';
 */

/**
 * Parse the given dynamic default value.
 * @param {object} args Arguments.
 * @param {Field} args.fieldConfig Field configuration.
 * @param {FieldKeyPath} args.keyPath Field key path, e.g. `author.name`.
 * @param {FlattenedEntryContent} args.newContent An object holding a content key-value map.
 * @param {string} args.value Dynamic default value.
 * @see https://decapcms.org/docs/dynamic-default-values/
 * @todo Validate the value carefully before adding it to the content map.
 */
const parseDynamicDefaultValue = ({ fieldConfig, keyPath, newContent, value }) => {
  const { widget: widgetName = 'string' } = fieldConfig;

  /**
   * Parse the value as a list and add the items to the key-value map.
   */
  const fillList = () => {
    newContent[keyPath] = [];

    value.split(/,\s*/).forEach((val, index) => {
      newContent[`${keyPath}.${index}`] = val;
    });
  };

  if (widgetName === 'boolean') {
    newContent[keyPath] = value === 'true';

    return;
  }

  if (widgetName === 'list') {
    const { field: subField, fields: subFields, types } = /** @type {ListField} */ (fieldConfig);
    const hasSubFields = !!subField || !!subFields || !!types;

    // Handle simple list
    if (!hasSubFields) {
      fillList();

      return;
    }
  }

  if (widgetName === 'markdown') {
    // Sanitize the given value to prevent XSS attacks as the preview may not be sanitized
    newContent[keyPath] = stripTags(value);

    return;
  }

  if (widgetName === 'number') {
    const { value_type: valueType = 'int' } = /** @type {NumberField} */ (fieldConfig);

    if (valueType === 'int' || valueType === 'float') {
      const val = valueType === 'int' ? Number.parseInt(value, 10) : Number.parseFloat(value);

      if (!Number.isNaN(val)) {
        newContent[keyPath] = val;
      }
    } else {
      newContent[keyPath] = value;
    }

    return;
  }

  if (widgetName === 'relation' || widgetName === 'select') {
    const { multiple = false } = /** @type {RelationField | SelectField} */ (fieldConfig);

    if (multiple) {
      fillList();

      return;
    }
  }

  // Just use the string as is
  newContent[keyPath] = value;
};

/**
 * Get the default values for the given fields. If dynamic default values are given, these values
 * take precedence over static default values defined with the site configuration.
 * @param {Field[]} fields Field list of a collection.
 * @param {InternalLocaleCode} locale Locale.
 * @param {Record<string, string>} [dynamicValues] Dynamic default values.
 * @returns {FlattenedEntryContent} Flattened entry content for creating a new draft content or
 * adding a new list item.
 * @todo Make this more diligent.
 */
export const getDefaultValues = (fields, locale, dynamicValues = {}) => {
  /** @type {FlattenedEntryContent} */
  const newContent = {};

  /**
   * Get the default value for the given field. Check if a dynamic default value is specified, then
   * look for the field configuration’s `default` property.
   * @param {object} args Arguments.
   * @param {Field} args.fieldConfig Field configuration.
   * @param {FieldKeyPath} args.keyPath Field key path, e.g. `author.name`.
   */
  const getDefaultValue = ({ fieldConfig, keyPath }) => {
    if (keyPath in dynamicValues) {
      parseDynamicDefaultValue({ fieldConfig, keyPath, newContent, value: dynamicValues[keyPath] });

      return;
    }

    // @ts-ignore `compute` and `uuid` widgets don’t have the `default` option
    const { widget: widgetName = 'string', default: defaultValue } = fieldConfig;
    const required = isFieldRequired({ fieldConfig, locale });
    const isArray = Array.isArray(defaultValue) && !!defaultValue.length;

    if (widgetName === 'list') {
      const { fields: subFields, types } = /** @type {ListField} */ (fieldConfig);

      if (!isArray) {
        newContent[keyPath] = [];

        return;
      }

      if (subFields || types) {
        defaultValue.forEach((items, index) => {
          Object.entries(items).forEach(([key, val]) => {
            newContent[[keyPath, index, key].join('.')] = val;
          });
        });

        return;
      }

      defaultValue.forEach((val, index) => {
        newContent[[keyPath, index].join('.')] = val;
      });

      return;
    }

    if (widgetName === 'object') {
      const { fields: subFields, types } = /** @type {ObjectField} */ (fieldConfig);

      if (!required || Array.isArray(types)) {
        // Enable validation
        newContent[keyPath] = null;
      } else {
        subFields?.forEach((_subField) => {
          getDefaultValue({
            keyPath: [keyPath, _subField.name].join('.'),
            fieldConfig: _subField,
          });
        });
      }

      return;
    }

    if (widgetName === 'boolean') {
      newContent[keyPath] = typeof defaultValue === 'boolean' ? defaultValue : false;

      return;
    }

    if (widgetName === 'code') {
      Object.assign(
        newContent,
        getDefaultCodeValue({
          // eslint-disable-next-line object-shorthand
          fieldConfig: /** @type {CodeField} */ (fieldConfig),
          keyPath,
        }),
      );

      return;
    }

    if (widgetName === 'relation' || widgetName === 'select') {
      const { multiple = false } = /** @type {RelationField | SelectField} */ (fieldConfig);

      if (multiple) {
        if (isArray) {
          defaultValue.forEach((value, index) => {
            newContent[[keyPath, index].join('.')] = value;
          });
        } else {
          newContent[keyPath] = [];
        }

        return;
      }
    }

    if (widgetName === 'datetime') {
      newContent[keyPath] = getDefaultDateTimeValue(/** @type {DateTimeField} */ (fieldConfig));

      return;
    }

    if (widgetName === 'hidden') {
      newContent[keyPath] = getDefaultHiddenValue(/** @type {HiddenField} */ (fieldConfig), locale);

      return;
    }

    if (widgetName === 'keyvalue') {
      Object.entries(getDefaultKvValue(/** @type {KeyValueField} */ (fieldConfig))).forEach(
        ([key, val]) => {
          newContent[`${keyPath}.${key}`] = String(val);
        },
      );

      return;
    }

    newContent[keyPath] = defaultValue !== undefined ? defaultValue : '';
  };

  fields.forEach((_field) => {
    getDefaultValue({
      keyPath: _field.name,
      fieldConfig: _field,
    });
  });

  return newContent;
};

/**
 * Create a Proxy that automatically copies a field value to other locale if the field’s i18n
 * strategy is “duplicate.”.
 * @param {object} args Arguments.
 * @param {EntryDraft | any} args.draft Entry draft.
 * @param {string} args.locale Source locale.
 * @param {object} [args.target] Target object.
 * @param {() => FlattenedEntryContent} [args.getValueMap] Optional function to get an object
 * holding the current entry values. It will be used for the `valueMap` argument of
 * {@link getFieldConfig}. If omitted, the proxy target will be used instead.
 * @returns {any} Created proxy.
 */
export const createProxy = ({
  draft: { collectionName, fileName },
  locale: sourceLocale,
  target = {},
  getValueMap = undefined,
}) => {
  const collection = getCollection(collectionName);

  const collectionFile = fileName
    ? /** @type {FileCollection} */ (collection)?._fileMap[fileName]
    : undefined;

  if (!collection || (fileName && !collectionFile)) {
    return undefined;
  }

  const {
    defaultLocale,
    canonicalSlug: { key: canonicalSlugKey },
  } = (collectionFile ?? collection)._i18n;

  return new Proxy(/** @type {any} */ (target), {
    // eslint-disable-next-line jsdoc/require-jsdoc
    set: (obj, /** @type {FieldKeyPath} */ keyPath, value) => {
      if (obj[keyPath] !== value) {
        obj[keyPath] = value;
      }

      // Skip the rest in some cases
      if ([canonicalSlugKey].includes(keyPath)) {
        return true;
      }

      const valueMap = typeof getValueMap === 'function' ? getValueMap() : obj;
      const getFieldConfigArgs = { collectionName, fileName, valueMap };
      const fieldConfig = getFieldConfig({ ...getFieldConfigArgs, keyPath });

      if (!fieldConfig) {
        return true;
      }

      const validity = get(entryDraft)?.validities?.[sourceLocale]?.[keyPath];

      // Update validity in real time if validation has already been performed
      if (validity) {
        // @todo Perform all the field validations, not just `valueMissing` for string fields
        if (typeof value === 'string' && isFieldRequired({ fieldConfig, locale: sourceLocale })) {
          validity.valueMissing = !value;
        }
      }

      // Copy value to other locales
      if (
        get(i18nAutoDupEnabled) &&
        fieldConfig.i18n === 'duplicate' &&
        sourceLocale === defaultLocale
      ) {
        Object.entries(/** @type {Record<string, any>} */ (get(entryDraft)).currentValues).forEach(
          ([targetLocale, content]) => {
            // Don’t duplicate the value if the parent object doesn’t exist
            if (keyPath.includes('.')) {
              const { path: parentKeyPath } = keyPath.match(/(?<path>.+?)\.[^.]*$/)?.groups ?? {};

              if (
                !Object.keys(content).some((_keyPath) =>
                  _keyPath.startsWith(`${parentKeyPath}.`),
                ) &&
                !getFieldConfig({ ...getFieldConfigArgs, keyPath: parentKeyPath })
              ) {
                return;
              }
            }

            // Support special case for the Relation field: if the `value_field` option is something
            // like `{{locale}}/{{slug}}`, replace the source locale in the value with target locale
            if (fieldConfig.widget === 'relation') {
              const { value_field: valueField = '{{slug}}' } = /** @type {RelationField} */ (
                fieldConfig
              );

              if (valueField.startsWith('{{locale}}/')) {
                value = value.replace(new RegExp(`^${sourceLocale}/`), `${targetLocale}/`);
              }
            }

            if (targetLocale !== sourceLocale && content[keyPath] !== value) {
              content[keyPath] = value;
            }
          },
        );
      }

      return true;
    },
  });
};

/**
 * Create an entry draft.
 * @param {object} args Arguments.
 * @param {InternalCollection} args.collection Collection that the entry belongs to.
 * @param {InternalCollectionFile} [args.collectionFile] Collection file. File collection only.
 * @param {any} [args.originalEntry] Entry to be edited, or a partial {@link Entry} object.
 * @param {Record<string, string>} [args.dynamicValues] Dynamic default values for a new entry
 * passed through URL parameters.
 * @param {LocaleExpanderMap} [args.expanderStates] Expander UI state. Can be set when resetting an
 * entry draft.
 */
export const createDraft = ({
  collection,
  collectionFile,
  originalEntry = {},
  dynamicValues,
  expanderStates,
}) => {
  const { name: collectionName, editor: { preview: entryPreview } = {} } = collection;
  const fileName = collectionFile?.name;
  const { id, slug, locales } = originalEntry;
  const isNew = id === undefined;
  const { fields = [], _i18n } = collectionFile ?? collection;
  const canPreview = entryPreview ?? get(siteConfig)?.editor?.preview ?? true;

  const {
    allLocales,
    initialLocales,
    defaultLocale,
    canonicalSlug: { key: canonicalSlugKey = 'translationKey' },
  } = _i18n;

  const enabledLocales = isNew
    ? initialLocales
    : allLocales.filter((locale) => !!locales?.[locale]?.content);

  const originalLocales = Object.fromEntries(
    allLocales.map((locale) => [locale, enabledLocales.includes(locale)]),
  );

  const originalSlugs = isNew
    ? {}
    : canonicalSlugKey in (locales?.[defaultLocale]?.content ?? {})
      ? Object.fromEntries(allLocales.map((locale) => [locale, locales?.[locale]?.slug]))
      : { _: locales?.[defaultLocale].slug };

  /** @type {LocaleContentMap} */
  const originalValues = Object.fromEntries(
    enabledLocales.map((locale) =>
      isNew
        ? [locale, getDefaultValues(fields, locale, dynamicValues)]
        : [locale, structuredClone(locales?.[locale]?.content)],
    ),
  );

  entryDraft.set({
    isNew: isNew && !fileName,
    canPreview,
    collectionName,
    collection,
    fileName,
    collectionFile,
    fields,
    originalEntry: isNew ? undefined : originalEntry,
    originalLocales,
    currentLocales: structuredClone(originalLocales),
    originalSlugs,
    currentSlugs: structuredClone(originalSlugs),
    originalValues,
    currentValues: Object.fromEntries(
      enabledLocales.map((locale) => [
        locale,
        createProxy({
          draft: { collectionName, fileName },
          locale,
          target: structuredClone(originalValues[locale]),
        }),
      ]),
    ),
    files: {},
    validities: Object.fromEntries(allLocales.map((locale) => [locale, {}])),
    // Any locale-agnostic view states will be put under the `_` key
    expanderStates: expanderStates ?? { _: {} },
  });

  restoreBackupIfNeeded({ collectionName, fileName, slug });
};

/**
 * Duplicate the current entry draft.
 */
export const duplicateDraft = () => {
  const draft = /** @type {EntryDraft} */ (get(entryDraft));
  const { collectionName, fileName, collection, collectionFile, currentValues, validities } = draft;
  const { defaultLocale } = (collectionFile ?? collection)._i18n;

  const {
    canonicalSlug: { key: canonicalSlugKey },
  } = (collectionFile ?? collection)._i18n;

  Object.entries(currentValues).forEach(([locale, valueMap]) => {
    // Remove the canonical slug
    delete valueMap[canonicalSlugKey];

    const getFieldConfigArgs = { collectionName, fileName, valueMap };

    // Reset some unique values
    Object.keys(valueMap).forEach((keyPath) => {
      const fieldConfig = getFieldConfig({ ...getFieldConfigArgs, keyPath });

      if (fieldConfig?.widget === 'uuid') {
        if (locale === defaultLocale || [true, 'translate'].includes(fieldConfig?.i18n ?? false)) {
          valueMap[keyPath] = getDefaultUuidValue(/** @type {UuidField} */ (fieldConfig));
        }
      }

      if (fieldConfig?.widget === 'hidden') {
        // The value could be array; normalize the key path, e.g. `tags.0` -> `tags`
        if (Array.isArray(fieldConfig.default) && keyPath.match(/\.\d+$/)) {
          delete valueMap[keyPath];
          keyPath = keyPath.replace(/\.\d+$/, '');

          if (keyPath in valueMap) {
            return;
          }
        }

        if (locale === defaultLocale || [true, 'translate'].includes(fieldConfig?.i18n ?? false)) {
          valueMap[keyPath] = getDefaultHiddenValue(
            /** @type {HiddenField} */ (fieldConfig),
            locale,
          );
        }
      }
    });
  });

  // Reset the validities
  Object.keys(validities).forEach((locale) => {
    validities[locale] = {};
  });

  entryDraft.set({
    ...draft,
    isNew: true,
    originalEntry: undefined,
    originalSlugs: {},
    currentSlugs: {},
  });

  showDuplicateToast.set(true);
};
