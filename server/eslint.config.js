import js from '@eslint/js';
import globals from 'globals';
import security from 'eslint-plugin-security';

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      'security/detect-object-injection': 'off',
      'security/detect-possible-timing-attacks': 'off',
      'no-control-regex': 'off',
    },
  },
];
