import type { ComponentProps, ReactNode } from 'react';
import { Button as HeadlessButton, Field as HeadlessField, Input, Label, Description, Disclosure as HeadlessDisclosure, DisclosureButton, DisclosurePanel, Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/react';
import { Icon } from './Icon';

const variants = { primary: 'bg-accent text-accent-fg hover:bg-accent-hover', secondary: 'bg-surface-3 text-fg hover:bg-surface-2', ghost: 'text-muted hover:bg-surface-3 hover:text-fg', danger: 'bg-danger-bg text-danger-fg hover:bg-danger-hover' };
const sizes = { sm: 'h-8 px-3 text-xs', md: 'h-9 px-4 text-sm' };
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export function Button({ variant = 'primary', size = 'md', className = '', type = 'button', ...props }: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return <HeadlessButton type={type} className={`interactive inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap active:scale-[0.98] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${focus} ${variants[variant]} ${sizes[size]} ${className}`} {...props} />;
}

export function Field({ label, hint, className = '', ...props }: ComponentProps<'input'> & { label: string; hint?: string }) {
  return <HeadlessField className="flex flex-col gap-1.5"><Label className="text-xs font-medium text-muted">{label}</Label><Input className={`interactive w-full min-w-0 rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-input-fg placeholder:text-input-placeholder focus:border-focus focus:outline-none data-[disabled]:opacity-50 ${className}`} {...props} />{hint ? <Description className="text-xs text-muted">{hint}</Description> : null}</HeadlessField>;
}

export function Card({ className = '', ...props }: ComponentProps<'div'>) { return <div className={`@container rounded-xl border border-border p-4 ${className}`} {...props} />; }
export function Badge({ className = '', ...props }: ComponentProps<'span'>) { return <span className={`inline-flex items-center rounded-full bg-surface-3 px-2 py-0.5 text-xs text-muted ${className}`} {...props} />; }

export function Tabs({ items, value, onChange }: { items: { id: string; label: ReactNode; children: ReactNode }[]; value?: string; onChange?: (id: string) => void }) {
  const index = value === undefined ? undefined : Math.max(0, items.findIndex(item => item.id === value));
  return <TabGroup selectedIndex={index} onChange={next => { const item = items[next]; if (item) onChange?.(item.id); }}><TabList className="flex gap-1 rounded-lg bg-surface-3 p-1">{items.map(item => <Tab key={item.id} className={`interactive flex-1 rounded-md px-3 py-1.5 text-sm text-muted data-[selected]:bg-surface data-[selected]:text-fg ${focus}`}>{item.label}</Tab>)}</TabList><TabPanels className="mt-3">{items.map(item => <TabPanel key={item.id}>{item.children}</TabPanel>)}</TabPanels></TabGroup>;
}

export function Disclosure({ title, children, defaultOpen }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return <HeadlessDisclosure defaultOpen={defaultOpen}>{({ open }) => <div className="rounded-lg border border-border"><DisclosureButton className={`interactive flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-3 ${focus}`}>{title}<Icon name="chevronRight" className={`interactive size-4 shrink-0 text-muted ${open ? 'rotate-90' : ''}`} /></DisclosureButton><div inert={!open} className={`grid transition-[grid-template-rows] duration-250 ease-[cubic-bezier(0.32,0.72,0,1)] ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}><div className="overflow-hidden"><DisclosurePanel static className="px-3 pb-3 text-sm">{children}</DisclosurePanel></div></div></div>}</HeadlessDisclosure>;
}
