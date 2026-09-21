import { Checkbox, Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions, Description, Disclosure, DisclosureButton, DisclosurePanel, Field as HeadlessField, Input, Label, Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HarnessId } from '../../shared/types';
import type { ProfileConfig, ProfileInput, ProfileOptions } from '../../shared/profiles';
import { Icon } from './Icon';
import { Button, Field } from './ui4a-ui';

type Option = { value: string; label: string; detail?: string };
type ProfileFieldsProps = { harness: HarnessId; config: ProfileConfig; onChange(config: ProfileConfig): void; options: ProfileOptions; credentials: ProfileInput['credentials']; configured: { apiKey: boolean; authToken: boolean }; onCredentialsChange(next: ProfileInput['credentials']): void; disabled: boolean };
const control = 'interactive w-full min-w-0 rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-input-fg placeholder:text-input-placeholder focus:border-input-focus focus:outline-none data-[disabled]:opacity-50';
const dropdownControl = 'interactive w-full min-w-0 rounded-lg border border-dropdown-border bg-dropdown-bg px-3 py-2 text-sm text-dropdown-fg focus-visible:outline-dropdown-focus data-[disabled]:opacity-50';
const popup = 'theme-menu z-popover max-h-[min(18rem,var(--anchor-max-height))] w-[var(--input-width)] min-w-48 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg p-1 outline-none';
const optionClass = 'menu-item min-h-9 cursor-pointer rounded-md px-2 py-1.5 text-fg data-[selected]:font-medium';
const optional = (value: string) => value || undefined;
const asOptions = (values: string[]): Option[] => [...new Set(values)].map(value => ({ value, label: value }));
const inherit = { value: '', label: '继承本机配置' };

/** Typing is a real value, so Tab or clicking Save keeps custom IDs without selecting a nearby suggestion. */
export function FreeChoice({ label, value = '', options, onChange, hint, disabled = false, placeholder = '继承本机配置' }: { label: string; value?: string; options: Option[]; onChange(value: string): void; hint?: string; disabled?: boolean; placeholder?: string }) {
  const [query, setQuery] = useState(''), tabbing = useRef(false), id = useId(), hintId = useId();
  const catalog = useMemo(() => [...new Map(options.filter(option => option.value).map(option => [option.value, option])).values()], [options]);
  const search = query.trim().toLowerCase(), matches = catalog.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(search));
  const choices: Option[] = [{ value: '', label: placeholder }, ...(search && !catalog.some(option => option.value === query) ? [{ value: query, label: `使用「${query}」` }] : []), ...matches];
  const byValue = new Map(choices.map(option => [option.value, option]));
  return <HeadlessField disabled={disabled} className="min-w-0"><Label htmlFor={id} className="mb-1.5 block text-xs font-medium text-muted">{label}</Label>
    <Combobox value={value} disabled={disabled} virtual={{ options: choices.map(option => option.value) }} onChange={next => { if (!tabbing.current) onChange(next ?? ''); }} onClose={() => { setQuery(''); tabbing.current = false; }} immediate>
      <div className="relative"><ComboboxInput id={id} aria-describedby={hint ? hintId : undefined} displayValue={(selected: string) => selected} autoComplete="off" spellCheck={false} placeholder={placeholder} onChange={event => { setQuery(event.target.value); onChange(event.target.value); }} onKeyDownCapture={event => { tabbing.current = event.key === 'Tab'; }} className={`${control} pr-9`} />
        <ComboboxButton aria-label={`浏览${label}`} className="interactive absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-lg text-input-fg data-[disabled]:opacity-50"><Icon name="chevronDown" className="size-3.5" /></ComboboxButton></div>
      <ComboboxOptions anchor={{ to: 'bottom start', gap: 6, padding: 16 }} modal={false} className={popup}>{({ option: id }: { option: string }) => {
        // Virtual rows can outlive a catalog/search update for one render; their stable ID remains a valid custom choice.
        const option = byValue.get(id) ?? { value: id, label: id };
        return <ComboboxOption value={id} className={optionClass}>{({ selected }) => <><Icon name="check" className={`size-3 shrink-0 ${selected ? '' : 'opacity-0'}`} /><span className="min-w-0"><span className="block break-words">{option.label}</span>{option.detail ? <span className="mt-0.5 block break-all text-xs">{option.detail}</span> : null}</span></>}</ComboboxOption>;
      }}</ComboboxOptions>
    </Combobox>{hint ? <Description id={hintId} className="mt-1.5 text-xs text-muted">{hint}</Description> : null}
  </HeadlessField>;
}

function Choice({ label, value, options, onChange, hint, disabled = false }: { label: string; value: string; options: Option[]; onChange(value: string): void; hint?: string; disabled?: boolean }) {
  const id = useId(), hintId = useId(), selected = options.find(option => option.value === value);
  const choices = selected ? options : [...options, { value, label: value }];
  return <HeadlessField disabled={disabled} className="min-w-0"><Label htmlFor={id} className="mb-1.5 block text-xs font-medium text-muted">{label}</Label>
    <Listbox value={value} onChange={onChange} disabled={disabled}><ListboxButton id={id} aria-describedby={hint ? hintId : undefined} className={`${dropdownControl} flex items-center justify-between gap-2 text-left`}><span className="min-w-0 truncate">{selected?.label ?? value}</span><Icon name="chevronDown" className="size-3.5 shrink-0" /></ListboxButton>
      <ListboxOptions anchor={{ to: 'bottom start', gap: 6, padding: 16 }} modal={false} className={`${popup} w-[var(--button-width)]`}>{choices.map(option => <ListboxOption key={option.value} value={option.value} className={optionClass}>{({ selected }) => <><Icon name="check" className={`size-3 shrink-0 ${selected ? '' : 'opacity-0'}`} /><span>{option.label}</span></>}</ListboxOption>)}</ListboxOptions>
    </Listbox>{hint ? <Description id={hintId} className="mt-1.5 text-xs text-muted">{hint}</Description> : null}
  </HeadlessField>;
}

function Advanced({ title, children }: { title: string; children: ReactNode }) {
  return <Disclosure as="section" className="border-t border-contrast pt-3"><DisclosureButton className="interactive group flex w-full items-center justify-between gap-3 rounded-md py-1 text-left text-sm font-medium text-muted hover:bg-surface-3 hover:text-hover-fg"><span>{title}</span><Icon name="chevronDown" className="size-3.5 group-data-[open]:rotate-180" /></DisclosureButton><DisclosurePanel className="pt-4">{children}</DisclosurePanel></Disclosure>;
}

function FeatureFields({ config, options, onChange, disabled }: Pick<ProfileFieldsProps, 'config' | 'options' | 'onChange' | 'disabled'>) {
  const [search, setSearch] = useState('');
  const features = options.features ?? [], known = new Set(features.map(feature => feature.id));
  const all = [...features, ...Object.entries(config.features ?? {}).filter(([id]) => !known.has(id)).map(([id, enabled]) => ({ id, name: id, enabled, description: '当前目录未返回此功能；保留已有配置。', stage: undefined, defaultEnabled: undefined, locked: false }))];
  const matches = all.filter(feature => `${feature.id} ${feature.name} ${feature.description ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const setFeature = (id: string, value: string) => { const next = { ...config.features }; if (value === '') delete next[id]; else next[id] = value === 'on'; onChange({ ...config, features: Object.keys(next).length ? next : undefined }); };
  return <Advanced title={`可选功能${all.length ? ` · ${all.length}` : ''}`}><Field label="搜索功能" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="名称或说明" disabled={disabled} />
    <div className="mt-3 max-h-80 space-y-4 overflow-y-auto pr-1">{matches.map(feature => {
      const inherited = '继承本机配置';
      return <Choice key={feature.id} label={feature.name} value={config.features?.[feature.id] === undefined ? '' : config.features[feature.id] ? 'on' : 'off'} onChange={value => setFeature(feature.id, value)} options={[{ value: '', label: inherited }, { value: 'on', label: '开启' }, { value: 'off', label: '关闭' }]} hint={[feature.description, feature.stage, feature.locked ? '由上层配置固定' : undefined].filter(Boolean).join(' · ')} disabled={disabled || feature.locked} />;
    })}{!matches.length ? <p role="status" className="text-xs text-muted">{all.length ? '没有匹配的功能' : '尚未获取功能列表；已有配置会保留。'}</p> : null}</div>
  </Advanced>;
}

function AgentModels({ config, options, onChange, disabled, models }: Pick<ProfileFieldsProps, 'config' | 'options' | 'onChange' | 'disabled'> & { models: Option[] }) {
  const [name, setName] = useState(''), [model, setModel] = useState('');
  const agents = [...new Set([...(options.agents ?? []).filter(agent => agent.subagent).map(agent => agent.id), ...Object.keys(config.agentModels ?? {})])];
  const setModelFor = (agent: string, model: string) => { const next = { ...config.agentModels }; if (model) next[agent] = model; else delete next[agent]; onChange({ ...config, agentModels: Object.keys(next).length ? next : undefined }); };
  return <Advanced title="子代理模型"><div className="grid gap-4 sm:grid-cols-2">{agents.map(agent => <FreeChoice key={agent} label={agent} value={config.agentModels?.[agent]} options={models} onChange={value => setModelFor(agent, value)} placeholder="继承此代理的模型" disabled={disabled} />)}</div>
    <div className={`${agents.length ? 'mt-5' : ''} grid items-end gap-3 sm:grid-cols-2`}><Field label="其他子代理名称" value={name} onChange={event => setName(event.target.value)} placeholder="已有的原生代理名称" disabled={disabled} /><FreeChoice label="其他子代理模型" value={model} options={models} onChange={setModel} disabled={disabled} placeholder="选择或输入模型 ID" /></div>
    <div className="mt-3 flex items-center justify-between gap-3"><p className="text-xs text-muted">按代理分别覆盖；留空沿用原生配置。</p><Button size="sm" variant="secondary" disabled={disabled || !name.trim() || !model.trim()} onClick={() => { setModelFor(name.trim(), model.trim()); setName(''); setModel(''); }}>添加覆写</Button></div>
  </Advanced>;
}

function CredentialFields({ harness, config, onChange, credentials, configured, onCredentialsChange, disabled }: Omit<ProfileFieldsProps, 'options'>) {
  const gatewayHarness = harness === 'hermes' || harness === 'openclaw', authMode = config.authMode ?? 'inherit', kind = authMode === 'auth-token' ? 'authToken' : 'apiKey';
  const label = kind === 'authToken' ? 'Bearer Token' : 'API Key', value = credentials?.[kind], saved = configured[kind] && value !== null;
  const clear = () => { onCredentialsChange({ ...credentials, [kind]: null }); onChange({ ...config, authMode: 'inherit' }); };
  return <div className="grid gap-4 sm:grid-cols-2"><Choice label="认证方式" value={authMode} onChange={value => onChange({ ...config, authMode: value as ProfileConfig['authMode'] })} options={[{ value: 'inherit', label: '继承本机认证' }, ...(gatewayHarness ? [{ value: 'auth-token', label: 'Gateway Token' }] : [{ value: 'api-key', label: 'API Key' }, ...(harness === 'claude-code' ? [{ value: 'auth-token', label: 'Bearer Token' }] : [])])]} hint={gatewayHarness ? 'Gateway 凭据留在本机，不会发送到浏览器。' : '本机登录凭据和环境变量保持不变。'} disabled={disabled} />
    {authMode !== 'inherit' ? <HeadlessField disabled={disabled} className="min-w-0"><div className="mb-1.5 flex items-center justify-between gap-2"><Label className="text-xs font-medium text-muted">{label}</Label>{saved || value ? <button type="button" onClick={clear} disabled={disabled} className="interactive rounded-sm text-xs text-muted hover:text-danger disabled:opacity-50">移除凭据</button> : null}</div><Input type="password" autoComplete="new-password" spellCheck={false} value={value ?? ''} onChange={event => onCredentialsChange({ ...credentials, [kind]: event.target.value || (value === null ? null : undefined) })} placeholder={saved ? '已配置；留空保持不变' : `输入 ${label}`} className={control} /><Description className="mt-1.5 text-xs text-muted">仅发送新输入的值，不显示已保存的凭据。</Description></HeadlessField> : <p role="status" className="self-center text-xs text-muted">{credentials?.apiKey === null || credentials?.authToken === null ? '保存后移除所选凭据。' : '使用 Harness 已有的登录方式。'}</p>}
  </div>;
}

export function ProfileFields(props: ProfileFieldsProps) {
  const { harness, config, onChange, options, disabled } = props;
  const update = (changes: Partial<ProfileConfig>) => onChange({ ...config, ...changes });
  const models = useMemo(() => options.models.map(model => ({ value: model.id, label: model.name, detail: model.name === model.id ? undefined : model.id })), [options.models]);
  const selected = options.models.find(model => model.id === config.model), child = options.models.find(model => model.id === config.subagentModel);
  const efforts = selected?.efforts ?? options.efforts, childEfforts = child?.efforts ?? options.efforts;
  const effortOptions = (values: string[]) => [inherit, ...asOptions(values).map(option => option.value === 'auto' ? { ...option, label: '自动 · 模型默认' } : option)];
  const aliases = ['opus', 'sonnet', 'haiku', 'fable'] as const;
  return <div className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2"><FreeChoice label="主模型" value={config.model} options={models} onChange={value => update({ model: optional(value) })} hint="搜索已知模型，或直接输入模型 ID。" disabled={disabled} />
      {harness === 'opencode' ? <FreeChoice label="模型变体" value={config.variant} options={asOptions(efforts)} onChange={value => update({ variant: optional(value) })} hint="使用该模型原生支持的推理或速度变体。" disabled={disabled} /> : <Choice label="推理力度" value={config.effort ?? ''} options={effortOptions(harness === 'claude-code' ? ['auto', ...efforts] : efforts)} onChange={value => update({ effort: optional(value) })} hint={efforts.length ? '仅覆盖这个 Profile 的推理设置。' : '选定模型后显示其支持的推理力度。'} disabled={disabled} />}
      {harness === 'claude-code' || harness === 'codex' ? <FreeChoice label="子代理模型" value={config.subagentModel} options={models} onChange={value => update({ subagentModel: optional(value), ...(harness === 'claude-code' && !value ? { forceSubagentModel: undefined } : {}) })} hint="留空沿用 Harness 的子代理配置。" disabled={disabled} /> : null}
      {harness === 'codex' ? <Choice label="子代理推理力度" value={config.subagentEffort ?? ''} options={effortOptions(childEfforts)} onChange={value => update({ subagentEffort: optional(value) })} disabled={disabled} /> : null}
      {harness === 'claude-code' && config.subagentModel ? <HeadlessField disabled={disabled} className="flex items-start gap-2.5 self-center"><Checkbox checked={config.forceSubagentModel ?? true} onChange={value => update({ forceSubagentModel: value })} className="interactive group mt-0.5 grid size-4 shrink-0 place-items-center rounded border border-control-border bg-input-bg data-[checked]:border-accent data-[checked]:bg-accent data-[checked]:text-accent-fg data-[disabled]:opacity-50"><Icon name="check" className="size-3 opacity-0 group-data-[checked]:opacity-100" /></Checkbox><div><Label className="text-sm">覆盖所有子代理的模型</Label><Description className="mt-1 text-xs text-muted">关闭后，仅为未指定模型的子代理设置默认值。</Description></div></HeadlessField> : null}
      {harness === 'opencode' || harness === 'openclaw' ? <FreeChoice label="主代理" value={config.agent} options={(options.agents ?? []).filter(agent => !agent.subagent).map(agent => ({ value: agent.id, label: agent.name }))} onChange={value => update({ agent: optional(value) })} disabled={disabled} /> : null}
    </div>
    <div className="grid gap-4 sm:grid-cols-2">{harness !== 'claude-code' && harness !== 'hermes' && harness !== 'openclaw' ? <FreeChoice label="Provider" value={config.provider} options={asOptions(options.models.flatMap(model => model.provider ? [model.provider] : []))} onChange={value => update({ provider: optional(value) })} placeholder="从所选模型推断" disabled={disabled} /> : null}{harness === 'hermes' || harness === 'openclaw' ? <Field label="Gateway 地址" type="url" inputMode="url" autoComplete="off" value={config.gatewayUrl ?? ''} onChange={event => update({ gatewayUrl: optional(event.target.value) })} placeholder={harness === 'openclaw' ? 'ws://127.0.0.1:18789' : 'ws://127.0.0.1:9119'} hint="留空使用本机默认 Gateway；SSH 场景填写转发后的地址。" disabled={disabled} /> : <Field label="API 地址" type="url" inputMode="url" autoComplete="off" value={config.baseUrl ?? ''} onChange={event => update({ baseUrl: optional(event.target.value) })} placeholder="继承原生服务地址" hint="自定义网关或兼容服务的 Base URL。" disabled={disabled} />}</div>
    <CredentialFields {...props} />
    {harness === 'hermes' || harness === 'openclaw' ? <Field label="原生 Profile" value={config.nativeProfile ?? ''} onChange={event => update({ nativeProfile: optional(event.target.value) })} placeholder="默认 Profile" hint="使用已配置的原生 Profile；模型服务地址与 API Key 在原生配置中管理。" disabled={disabled} /> : null}
    {harness === 'opencode' ? <AgentModels config={config} options={options} onChange={onChange} disabled={disabled} models={models} /> : null}
    {harness === 'codex' ? <FeatureFields config={config} options={options} onChange={onChange} disabled={disabled} /> : null}
    {harness === 'claude-code' ? <Advanced title="模型别名与流式传输"><div className="grid gap-4 sm:grid-cols-2">{aliases.map(alias => <FreeChoice key={alias} label={`${alias} 模型别名`} value={config.modelAliases?.[alias]} options={models} onChange={value => { const next = { ...config.modelAliases }; if (value) next[alias] = value; else delete next[alias]; update({ modelAliases: Object.keys(next).length ? next : undefined }); }} disabled={disabled} />)}<Choice label="细粒度工具流" value={config.fineGrainedToolStreaming === undefined ? '' : config.fineGrainedToolStreaming ? 'on' : 'off'} options={[inherit, { value: 'on', label: '开启' }, { value: 'off', label: '关闭' }]} onChange={value => update({ fineGrainedToolStreaming: value === '' ? undefined : value === 'on' })} hint="逐步接收工具参数；服务端需支持对应能力。" disabled={disabled} /></div></Advanced> : null}
  </div>;
}
