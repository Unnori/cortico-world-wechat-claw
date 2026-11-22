import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { TTS_SPEED_MAX, TTS_SPEED_MIN, type TtsPanelState, type TtsProtocol, type TtsSettings } from '../config.ts';
import type { TtsCatalog } from '../media/tts-catalog.ts';
import type { LocalTtsService } from '../media/tts-local.ts';

function strings(language: string) {
  return language.startsWith('zh') ? {
    title: 'TTS 设置',
    description: '将桌宠的文字合成为语音并发到微信。',
    enabled: '启用 TTS',
    on: '已启用',
    off: '未启用',
    loading: '正在读取设置…',
    loadFailed: '无法读取 TTS 设置',
    serviceUrl: '服务地址',
    protocol: '服务类型',
    openai: 'OpenAI 兼容',
    discover: '发现本机与局域网服务',
    discovering: '正在查找 GPT-SoVITS…',
    discoverEmpty: '未找到可直连的 GPT-SoVITS。请确认语音接口已开启，也可手动填写地址。',
    discoverFailed: '暂时无法查找语音服务。',
    selectService: '选择发现的 GPT-SoVITS 服务',
    serviceSelected: '已填入服务配置，保存后生效。',
    currentVoice: '留空使用服务当前音色',
    model: '模型',
    voice: '声音',
    speed: '语速',
    fetchModels: '获取模型',
    fetchVoices: '获取音色',
    chooseModel: '选择模型',
    chooseVoice: '选择音色',
    listLoading: '正在获取…',
    listEmpty: '没有可用选项，可手动填写。',
    preset: '预置',
    custom: '自定义',
    save: '保存设置',
    saved: '设置已生效',
    keySaved: '已保存密钥',
    keyMissing: '未设置密钥',
    keyHint: '服务需要鉴权时填写。输入新密钥可替换现有密钥。',
    saveKey: '保存密钥',
    keyFailed: '密钥保存失败',
  } : {
    title: 'TTS settings',
    description: 'Turn the pet’s text into speech and send it to WeChat.',
    enabled: 'Enable TTS',
    on: 'Enabled',
    off: 'Disabled',
    loading: 'Reading settings…',
    loadFailed: 'Could not read TTS settings',
    serviceUrl: 'Service URL',
    protocol: 'Service type',
    openai: 'OpenAI compatible',
    discover: 'Find local and LAN services',
    discovering: 'Looking for GPT-SoVITS…',
    discoverEmpty: 'No reachable GPT-SoVITS service found. Check that its voice API is enabled, or enter its URL manually.',
    discoverFailed: 'Could not look for voice services.',
    selectService: 'Select a discovered GPT-SoVITS service',
    serviceSelected: 'Service details filled in. Save settings to apply them.',
    currentVoice: 'Leave blank to use the service’s current voice',
    model: 'Model',
    voice: 'Voice',
    speed: 'Speed',
    fetchModels: 'Fetch models',
    fetchVoices: 'Fetch voices',
    chooseModel: 'Select a model',
    chooseVoice: 'Select a voice',
    listLoading: 'Loading options…',
    listEmpty: 'No options found. You can enter a value manually.',
    preset: 'Preset',
    custom: 'Custom',
    save: 'Save settings',
    saved: 'Settings applied',
    keySaved: 'Key saved',
    keyMissing: 'No key configured',
    keyHint: 'Enter a key if your service requires one. A new key replaces the saved key.',
    saveKey: 'Save key',
    keyFailed: 'Could not save the key',
  };
}

type Strings = ReturnType<typeof strings>;

function catalogField(
  ctx: WebUiPanelContext,
  t: Strings,
  field: { label: string; button: string; placeholder: string; input: HTMLInputElement; load: () => Promise<TtsCatalog> },
) {
  const { ui, signal } = ctx;
  const { label, input } = field;
  const box = ui.h('div', 'wcc-tts-lookup');
  const button = ui.button(field.button, { size: 'sm' });
  const select = ui.select();
  select.hidden = true;
  select.setAttribute('aria-label', field.placeholder);
  const status = ui.msgline();
  status.setAttribute('role', 'status');
  box.append(ui.field(label, input), button, select, status);

  let revision = 0;
  const clear = (): void => {
    revision++;
    select.hidden = true;
    select.replaceChildren();
    status.classList.remove('bad');
    status.textContent = '';
  };
  select.addEventListener('change', () => {
    if (!select.value) return;
    input.value = select.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { signal });
  input.addEventListener('input', () => {
    const matches = Array.from(select.options).some(option => option.value === input.value);
    select.value = matches ? input.value : '';
  }, { signal });
  button.addEventListener('click', () => {
    clear();
    const request = revision;
    button.disabled = true;
    status.textContent = t.listLoading;
    void field.load().then(result => {
      if (request !== revision || signal.aborted) return;
      const placeholder = ui.h('option', '', field.placeholder);
      placeholder.value = '';
      select.append(placeholder);
      for (const choice of result.choices) {
        const text = choice.source ? choice.label + ' · ' + t[choice.source] : choice.label;
        const option = ui.h('option', '', text);
        option.value = choice.value;
        select.append(option);
      }
      select.hidden = result.choices.length === 0;
      select.value = input.value;
      if (select.selectedIndex < 0) select.value = '';
      status.textContent = result.note ?? (select.hidden ? t.listEmpty : '');
    }, error => {
      if (request !== revision || signal.aborted) return;
      status.classList.add('bad');
      status.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => { button.disabled = false; });
  }, { signal });
  return { box, clear };
}

function ttsForm(
  ctx: WebUiPanelContext,
  t: Strings,
  state: TtsPanelState,
  onChange: (state: TtsPanelState) => void,
): HTMLElement {
  const { ui, signal } = ctx;
  const body = ui.h('div', 'wcc-tts-drawer');
  const settings = ui.h('form', 'wcc-tts-form');
  const enabled = ui.checkbox(t.enabled, { checked: state.ttsEnabled });
  const protocol = ui.select();
  for (const [value, label] of [['openai', t.openai], ['gpt-sovits', 'GPT-SoVITS']]) {
    const option = ui.h('option', '', label);
    option.value = value;
    protocol.append(option);
  }
  protocol.value = state.ttsProtocol;
  const selectedProtocol = () => protocol.value as TtsProtocol;
  const url = ui.input({ value: state.ttsBaseUrl });
  url.type = 'url';
  const model = ui.input({ value: state.ttsModel });
  const voice = ui.input({ value: state.ttsVoice });
  const speed = ui.input({ type: 'number', value: String(state.ttsSpeed) });
  speed.min = String(TTS_SPEED_MIN);
  speed.max = String(TTS_SPEED_MAX);
  speed.step = 'any';
  speed.required = true;
  const modelField = catalogField(ctx, t, {
    label: t.model, button: t.fetchModels, placeholder: t.chooseModel, input: model,
    load: () => ctx.invoke<TtsCatalog>('tts-list-models', [url.value, selectedProtocol()]),
  });
  const voiceField = catalogField(ctx, t, {
    label: t.voice, button: t.fetchVoices, placeholder: t.chooseVoice, input: voice,
    load: () => ctx.invoke<TtsCatalog>('tts-list-voices', [url.value, model.value, selectedProtocol()]),
  });
  let voiceModel = model.value.trim();
  model.addEventListener('input', () => {
    const next = model.value.trim();
    if (next === voiceModel) return;
    voiceModel = next;
    voice.value = '';
    voiceField.clear();
  }, { signal });
  const serviceFields = ui.h('div', 'wcc-tts-service');
  const discover = ui.button(t.discover, { size: 'sm' });
  const services = ui.select();
  services.hidden = true;
  services.setAttribute('aria-label', t.selectService);
  const discoveryStatus = ui.msgline();
  discoveryStatus.setAttribute('role', 'status');
  const discoveryActions = ui.rowbar();
  discoveryActions.classList.add('wcc-tts-discovery-actions');
  discoveryActions.append(discover, services);
  serviceFields.append(ui.field(t.protocol, protocol), ui.field(t.serviceUrl, url), discoveryActions, discoveryStatus);
  const fields = ui.h('div', 'wcc-tts-fields');
  fields.append(modelField.box, voiceField.box, ui.field(t.speed, speed));
  const save = ui.button(t.save, { variant: 'primary' });
  save.type = 'submit';
  const settingsStatus = ui.msgline();
  settingsStatus.setAttribute('role', 'status');
  const actions = ui.rowbar();
  actions.append(save, settingsStatus);
  settings.append(enabled.el, serviceFields, fields, actions);

  const credentials = ui.h('form', 'wcc-tts-key');
  const key = ui.input({ type: 'password' });
  key.autocomplete = 'new-password';
  const saveKey = ui.button(t.saveKey);
  saveKey.type = 'submit';
  saveKey.disabled = true;
  const keyStatus = ui.msgline(state.keyConfigured ? t.keySaved : t.keyMissing);
  keyStatus.setAttribute('role', 'status');
  const keyRow = ui.rowbar();
  keyRow.append(ui.field('API Key', key), saveKey);
  credentials.append(keyRow, ui.h('div', 'sectiondesc', t.keyHint), keyStatus);
  body.append(settings, credentials);

  let keyRevision = 0;
  let serviceRevision = 0;
  const updateKeyState = async () => {
    const revision = ++keyRevision;
    keyStatus.classList.remove('bad');
    keyStatus.textContent = '';
    try {
      const { keyConfigured } = await ctx.invoke<Pick<TtsPanelState, 'keyConfigured'>>('tts-key-state', [selectedProtocol(), url.value]);
      if (!signal.aborted && revision === keyRevision) keyStatus.textContent = keyConfigured ? t.keySaved : t.keyMissing;
    } catch {
      // The URL may still be incomplete while it is being edited.
    }
  };
  const updateServiceFields = () => {
    const local = selectedProtocol() === 'gpt-sovits';
    url.placeholder = local ? 'http://127.0.0.1:9880' : 'https://example.com/v1';
    voice.placeholder = local ? t.currentVoice : '';
  };
  const serviceChanged = () => {
    modelField.clear();
    voiceField.clear();
    keyRevision++;
    key.value = '';
    saveKey.disabled = true;
    keyStatus.textContent = '';
    keyStatus.classList.remove('bad');
    settingsStatus.textContent = '';
    updateServiceFields();
  };
  const clearDiscovery = () => {
    serviceRevision++;
    services.hidden = true;
    services.replaceChildren();
    discoveryStatus.textContent = '';
  };
  const applyService = (service: LocalTtsService) => {
    const sameService = selectedProtocol() === 'gpt-sovits' && url.value.trim() === service.baseUrl;
    protocol.value = 'gpt-sovits';
    url.value = service.baseUrl;
    model.value = voiceModel = service.model;
    if (!sameService) voice.value = '';
    serviceChanged();
    void updateKeyState();
    discoveryStatus.textContent = t.serviceSelected;
  };
  updateServiceFields();
  protocol.addEventListener('change', () => {
    model.value = voiceModel = voice.value = '';
    clearDiscovery();
    serviceChanged();
    void updateKeyState();
  }, { signal });
  url.addEventListener('input', () => {
    clearDiscovery();
    serviceChanged();
  }, { signal });
  url.addEventListener('change', () => { void updateKeyState(); }, { signal });

  let discovered: LocalTtsService[] = [];
  services.addEventListener('change', () => {
    const choice = discovered.find(service => service.baseUrl === services.value);
    if (choice && !save.disabled) applyService(choice);
  }, { signal });
  discover.addEventListener('click', () => {
    if (save.disabled) return;
    clearDiscovery();
    const revision = serviceRevision;
    discover.disabled = true;
    discoveryStatus.textContent = t.discovering;
    void ctx.invoke<LocalTtsService[]>('tts-discover', [url.value]).then(results => {
      if (signal.aborted || revision !== serviceRevision) return;
      discovered = results;
      if (!results.length) { discoveryStatus.textContent = t.discoverEmpty; return; }
      if (results.length === 1) { applyService(results[0]!); return; }
      const placeholder = ui.h('option', '', t.selectService);
      placeholder.value = '';
      services.append(placeholder);
      for (const service of results) {
        const option = ui.h('option', '', service.baseUrl);
        option.value = service.baseUrl;
        services.append(option);
      }
      services.hidden = false;
      discoveryStatus.textContent = '';
    }, () => {
      if (!signal.aborted && revision === serviceRevision) discoveryStatus.textContent = t.discoverFailed;
    }).finally(() => { discover.disabled = false; });
  }, { signal });

  settings.addEventListener('submit', event => {
    event.preventDefault();
    if (save.disabled) return;
    if (discover.disabled) clearDiscovery();
    const patch: TtsSettings = {
      ttsEnabled: enabled.checked,
      ttsProtocol: selectedProtocol(),
      ttsBaseUrl: url.value,
      ttsModel: model.value,
      ttsVoice: voice.value,
      ttsSpeed: speed.valueAsNumber,
    };
    const pending = ui.disable(save, enabled.input, protocol, url, model, voice, speed, services);
    settingsStatus.textContent = '';
    void ctx.invoke<TtsPanelState>('tts-save-settings', [patch]).then(next => {
      onChange(next);
      discoveryStatus.textContent = '';
      settingsStatus.classList.remove('bad');
      settingsStatus.textContent = t.saved;
    }, error => {
      settingsStatus.classList.add('bad');
      settingsStatus.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => pending.dispose());
  }, { signal });

  key.addEventListener('input', () => { saveKey.disabled = !key.value.trim(); }, { signal });
  credentials.addEventListener('submit', event => {
    event.preventDefault();
    const value = key.value.trim();
    if (!value || saveKey.disabled) return;
    const pending = ui.disable(saveKey, key);
    const revision = ++keyRevision;
    void ctx.invoke('tts-save-key', [value, selectedProtocol(), url.value]).then(() => {
      if (signal.aborted || revision !== keyRevision) return;
      key.value = '';
      keyStatus.classList.remove('bad');
      keyStatus.textContent = t.keySaved;
    }, () => {
      if (signal.aborted || revision !== keyRevision) return;
      keyStatus.classList.add('bad');
      keyStatus.textContent = t.keyFailed;
    }).finally(() => {
      pending.dispose();
      saveKey.disabled = !key.value.trim();
    });
  }, { signal });
  return body;
}

export async function mountTts(ctx: WebUiPanelContext, parent: HTMLElement): Promise<void> {
  const { ui, signal } = ctx;
  const t = strings(ctx.language);
  const section = ui.h('section', 'wcc-service');
  const status = ui.msgline(t.loading);
  status.setAttribute('role', 'status');
  const actions = ui.actions();
  const configure = ui.button(t.title, { variant: 'primary' });
  actions.append(configure);
  section.append(ui.section('TTS', t.description), status, actions);
  parent.append(section);

  const paint = (state: TtsPanelState): void => {
    status.classList.remove('bad');
    status.classList.toggle('wcc-tts-off', !state.ttsEnabled);
    status.textContent = state.ttsEnabled && state.ttsModel
      ? `${t.on}：${state.ttsModel}`
      : state.ttsEnabled ? t.on : t.off;
  };
  const load = async (): Promise<TtsPanelState | null> => {
    try {
      const next = await ctx.invoke<TtsPanelState>('tts-state');
      paint(next);
      return next;
    } catch {
      status.classList.add('bad');
      status.textContent = t.loadFailed;
      return null;
    }
  };

  configure.addEventListener('click', () => {
    configure.disabled = true;
    void load().then(state => {
      if (state && !signal.aborted) ui.drawer(t.title, ttsForm(ctx, t, state, paint));
    }).finally(() => { configure.disabled = false; });
  }, { signal });
  await load();
}
