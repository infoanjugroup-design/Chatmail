/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        dusk: '#1B1B3A',       // deep indigo-navy — chat surface
        dusk2: '#2B2B52',      // panel / card surface
        coral: '#FF6F61',      // primary accent — sends, active states
        gold: '#F2B84B',       // stories ring / mood-ring accent
        mint: '#3ED9B0',       // delivered/read receipts, success
        paper: '#FBF8F4',      // message bubble (received)
        ink: '#161629',
      },
      fontFamily: {
        display: ['"Fraunces"', 'serif'],
        body: ['"Inter"', 'sans-serif'],
      },
      borderRadius: {
        bubble: '18px',
      },
    },
  },
  plugins: [],
};
