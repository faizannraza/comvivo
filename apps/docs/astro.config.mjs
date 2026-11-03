// The documentation site (`13` §3.C.1–§3.C.4).
//
// M0 is the skeleton: Astro, Starlight and the links validator, with every page from `13` §3.C.3
// present as a draft. The rest of §3.C.1's plugin list — starlight-openapi, starlight-typedoc,
// starlight-llms-txt, starlight-blog, image zoom, Mermaid, Lunaria — arrives with the artefact
// each one renders. There is no `openapi.json` to generate a reference from and no SDK to run
// TypeDoc over, so adding them now would be adding dependencies that render nothing.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

// Cloudflare Pages at the apex domain is the destination (`13` §3.C.2 — GitHub Pages' 100 GB/month
// soft bandwidth limit rules it out). Neither the domain nor the Cloudflare account exists yet, so
// the site URL comes from the environment and falls back to something that builds anywhere.
const site = process.env.DOCS_SITE ?? 'https://comvivo.dev';

export default defineConfig({
  site,
  // Trailing slashes everywhere, matching the paths `13` §3.C.3 specifies. Chosen explicitly
  // because a later change would break every external link to the docs.
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Comvivo',
      description:
        'A self-hosted AI assistant that belongs to a group, not to one person. Your household’s chat, your machine, your data.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/faizannraza/comvivo' }],
      editLink: {
        baseUrl: 'https://github.com/faizannraza/comvivo/edit/main/apps/docs/',
      },
      lastUpdated: true,
      plugins: [
        // Fails the build on a broken internal link. On a site whose whole job is explaining a
        // privacy model, a link into nothing is the fastest way to lose a reader's trust.
        //
        // `errorOnRelativeLinks` is off: every page here is currently a draft, and Starlight
        // excludes drafts from a production build, so a link between two real pages would
        // otherwise be reported as broken during M0 only. It goes on when the pages do.
        starlightLinksValidator({
          errorOnRelativeLinks: false,
          errorOnInvalidHashes: true,
        }),
      ],
      sidebar: [
        { label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
        { label: 'For group members', items: [{ autogenerate: { directory: 'members' } }] },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Operate', items: [{ autogenerate: { directory: 'operate' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Extend', items: [{ autogenerate: { directory: 'extend' } }] },
        { label: 'Privacy & trust', items: [{ autogenerate: { directory: 'trust' } }] },
        { label: 'Project', items: [{ autogenerate: { directory: 'project' } }] },
      ],
      customCss: ['./src/styles/custom.css'],
      // Starlight ships Pagefind; nothing to configure for it here.
    }),
  ],
});
