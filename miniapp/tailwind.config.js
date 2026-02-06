/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        towns: {
          primary: '#7C3AED',
          secondary: '#4F46E5',
          accent: '#10B981',
          dark: '#1F2937',
          light: '#F9FAFB',
        },
      },
    },
  },
  plugins: [],
}
