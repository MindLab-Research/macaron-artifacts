import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import type { MDXComponents } from 'mdx/types';

function NightlyCommand({ prefix }: { prefix: string }) {
  return <DynamicCodeBlock lang="sh" code={`${prefix} https://pkg.pr.new/macaron-artifacts@${__COMMIT_SHA__}`} />;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Steps,
    Step,
    Tabs,
    Tab,
    TypeTable,
    Files,
    File,
    Folder,
    Accordion,
    Accordions,
    NightlyCommand,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
