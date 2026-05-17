import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'pi-cost',
  description: 'Cost dashboard for the pi coding agent.',
  base: '/pi-cost/',
  cleanUrls: true,
  ignoreDeadLinks: true,
  appearance: 'dark',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/pi-cost/icons/icon.svg' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/pi-cost/icons/icon-192.png' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'pi-cost' }],
    ['meta', { property: 'og:description', content: 'Cost dashboard for the pi coding agent.' }],
    ['meta', { property: 'og:url', content: 'https://nikiforovall.blog/pi-cost/' }],
    ['meta', { property: 'og:image', content: 'https://nikiforovall.blog/pi-cost/og-preview.png' }],
    ['meta', { property: 'og:image:width', content: '3829' }],
    ['meta', { property: 'og:image:height', content: '1905' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'pi-cost' }],
    ['meta', { name: 'twitter:description', content: 'Cost dashboard for the pi coding agent.' }],
    ['meta', { name: 'twitter:image', content: 'https://nikiforovall.blog/pi-cost/og-preview.png' }],
  ],
  themeConfig: {
    logo: '/icons/icon.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'User Guide', link: '/user-guide' },
      { text: 'Theming', link: '/theming' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'User Guide', link: '/user-guide' },
          { text: 'Theming', link: '/theming' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/NikiforovAll/pi-cost' },
    ],
    editLink: {
      pattern: 'https://github.com/NikiforovAll/pi-cost/edit/main/docs/:path',
    },
  },
});
