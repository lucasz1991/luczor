const pluginVitest = require('@vitest/eslint-plugin')
const skipFormatting = require('@vue/eslint-config-prettier/skip-formatting')
const { defineConfigWithVueTs, vueTsConfigs } = require('@vue/eslint-config-typescript')
const security = require('eslint-plugin-security')
const pluginVue = require('eslint-plugin-vue')

/** @type {import('eslint').Linter.Config[]} */
module.exports = defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{ts,mts,tsx,vue}'],
  },

  {
    name: 'app/files-to-ignore',
    ignores: ['**/dist/**', 'src/vendor/**', '**/dist-ssr/**', '**/coverage/**', '**/test-results/**', '*.config.*'],
  },

  {
    name: 'app/rules',
    rules: {
      'no-var': 'error',
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'comma-dangle': ['error', 'only-multiline'],
      'id-length': [2, { exceptions: ['i', 'j', 'e', 'z', '_'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,

  {
    ...pluginVitest.configs.recommended,
    files: ['tests/unit/**/*'],
  },

  skipFormatting,

  security.configs.recommended,

  {
    name: 'app/security-gates',
    rules: {
      // Promote security findings to hard failures. Reviewed legacy dynamic
      // index accesses live in the count-based suppressions file, so any new
      // occurrence fails CI until it is audited explicitly.
      'security/detect-object-injection': 'error',
      'security/detect-non-literal-regexp': 'error',
    },
  }
)
