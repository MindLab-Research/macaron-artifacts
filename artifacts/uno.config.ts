import { defineConfig, transformerDirectives, transformerVariantGroup } from 'unocss';
import { unoConfig } from './src/web/theme/uno';
export default defineConfig({ ...unoConfig(), transformers: [transformerVariantGroup(), transformerDirectives()] });
