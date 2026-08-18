import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const developmentConnectSources = process.env.NODE_ENV === 'production' ? [] : ['ws://127.0.0.1:*'];

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
        'font-src': ['self', 'https://fonts.gstatic.com'],
        'img-src': ['self', 'data:', 'https:'],
        'connect-src': [
          'self',
          ...developmentConnectSources,
          'https://*.supabase.co',
          'wss://*.supabase.co',
          'https://api.openrouter.ai',
          'https://api.cdp.coinbase.com',
          'https://*.stellar8004.com',
          'https://*.sorobanrpc.com',
          'https://horizon.stellar.org'
        ],
        'frame-ancestors': ['none'],
        'base-uri': ['self'],
        'form-action': ['self']
      }
    }
  }
};

export default config;
