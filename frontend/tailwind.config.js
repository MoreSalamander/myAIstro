/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        truth: "#3b82f6",     // Source of Truth
        core: "#a855f7",      // Agent Core
        open: "#f59e0b",      // Open Model

        success: "#22c55e",   // Validation PASS
        danger: "#ef4444",    // Validation FAIL
      },
    },
  },
  plugins: [],
};
