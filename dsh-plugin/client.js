window.__ModuleLoader__.load({
  id: '@local/ta-super-agent-dsh',
  factory(require) {
    const { createElement: h, useState, useSyncExternalStore } = require('react');
    const namespace = 'ta-super-agent-connection';
    const fields = [
      ['host', '服务器 IP 或主机名', 'text'],
      ['port', 'SSH 端口', 'number'],
      ['username', 'SSH 用户名', 'text'],
      ['password', 'SSH 密码', 'password'],
      ['fingerprint', 'SSH 主机指纹', 'text'],
      ['remoteDir', '助教服务目录', 'text'],
      ['apiPort', '助教 API 内网端口', 'number'],
      ['courseId', '默认课程 ID（可选，自动加载最近情况）', 'text'],
    ];

    function ConnectionForm({ form }) {
      const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot());
      const [draft, setDraft] = useState({});
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState('');
      const [editRevision, setEditRevision] = useState(undefined);
      async function save(event) {
        event.preventDefault();
        if (saving) return;
        const changes = fields.filter(([key]) => Object.hasOwn(draft, key) && (key !== 'password' || draft[key] !== ''));
        const operations = changes.map(([key, , type]) => ({
          op: 'set', path: [key], value: type === 'number' ? Number(draft[key]) : key === 'password' ? draft[key] : draft[key].trim(),
        }));
        if (!operations.length) return;
        setSaving(true);
        setMessage('');
        try {
          if (!await form.mutate(operations, editRevision)) {
            setMessage('保存失败。请检查参数，或重新打开配置后再试。');
            return;
          }
          setDraft({});
          setEditRevision(undefined);
          setMessage('已保存。');
        } catch {
          setMessage('保存失败，请稍后重试。');
        } finally { setSaving(false); }
      }
      return h('form', { onSubmit: save, style: { display: 'grid', gap: '12px', maxWidth: '36rem' } },
        fields.map(([key, label, type]) => h('label', { key, style: { display: 'grid', gap: '4px' } },
          label,
          h('input', {
            name: key, type, disabled: saving,
            value: draft[key] ?? (key === 'password' ? '' : snapshot.value?.[key] ?? ''),
            ...(type === 'number' ? { min: 1, max: 65535, step: 1, required: true } : {}),
            ...(type === 'password' ? { autoComplete: 'new-password', placeholder: '留空保留已保存的密码' } : {}),
            className: 'border rounded-md px-3 py-2',
            onChange: event => {
              if (!Object.keys(draft).length) setEditRevision(snapshot.revision);
              setDraft({ ...draft, [key]: event.target.value });
              setMessage('');
            },
          }))),
        h('button', { type: 'submit', className: 'border rounded-md px-3 py-2', disabled: saving || !Object.keys(draft).length }, saving ? '正在保存…' : '保存连接参数'),
        message && h('p', { role: 'status' }, message));
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          // Match the Host question card only when it contains this plugin's heading.
          style.textContent = `
            .ta-approval-preview [class$="_body"] > [class$="_detail"] {
              box-sizing: border-box;
              padding-inline: 24px;
              padding-block: 10px 16px;
              overflow-wrap: anywhere;
            }
          `;
          document.head.append(style);
          const marked = new Set();
          const update = () => {
            for (const card of marked) if (!card.isConnected) marked.delete(card);
            for (const heading of document.querySelectorAll('[class$="_header"] [class$="_eyebrow"]')) {
              const card = heading.closest('[class$="_card"]');
              if (!card) continue;
              const owned = heading.textContent.trim() === '助教操作' || heading.textContent.trim() === '派发作业';
              card.classList.toggle('ta-approval-preview', owned);
              if (owned) marked.add(card);
            }
          };
          const observer = new MutationObserver(update);
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          update();
          return () => {
            observer.disconnect();
            for (const card of marked) card.classList.remove('ta-approval-preview');
            style.remove();
          };
        });
        ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: '@local/ta-super-agent-dsh#' + namespace,
        }, ({ view }) => view === 'page' ? h(ConnectionForm, { form: ctx.configForms.get(namespace) }) : '配置助教服务器的 SSH 连接。'))));
      },
    };
  },
});
