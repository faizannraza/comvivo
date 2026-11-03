import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Declared even though there are no translations yet. Starlight warns on every build without it
  // — "the collection i18n does not exist or is empty" — and a warning printed on every build is a
  // warning nobody reads. `13` §3.C covers the Lunaria and Weblate wiring when translation starts.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
