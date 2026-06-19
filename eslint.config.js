import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // The Jules API responses are loosely typed at the boundary; allow `any`
            // in the client/tool glue rather than scattering casts.
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-empty-object-type': 'off', // SessionCompleted {} marker type
            '@typescript-eslint/no-unsafe-function-type': 'off', // test mocks use `Function` deliberately
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
);
