import { useState, useEffect } from 'react'
import { Check, Save } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import { ipc } from '../../services/ipc-client'
import { Switch } from '../ui/Switch'
import { useLocaleStore } from '../../stores/locale-store'
import { logFailure } from '../../shared/fail-log'

function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function ProxySection() {
  const text = useLocaleStore(s => s.text)
  const [proxy, setProxy] = useState<{
    enabled: boolean; type: 'http' | 'socks5'; host: string; port: number
  }>({ enabled: false, type: 'http', host: '', port: 7890 })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke('config:get').then((cfg) => {
      if (cfg?.proxy) {
        setProxy({
          enabled: cfg.proxy.enabled ?? false, // 明确默认关闭
          type: cfg.proxy.type ?? 'http',
          host: cfg.proxy.host ?? '',
          port: cfg.proxy.port ?? 7890,
        })
      }
    }).catch((error) => {
      logFailure('Settings', 'failed to load proxy config', error)
    })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await ipc.invoke('config:set', { proxy })
      if (!result.success) throw new Error(result.error || text('未知错误', 'Unknown error'))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      setSaved(false)
      setSaveError(text(
        `代理配置保存失败：${thrownMessage(error)}`,
        `Could not save proxy settings: ${thrownMessage(error)}`,
      ))
    } finally {
      setSaving(false)
    }
  }

  let proxySaveLabel = text('保存代理配置', 'Save proxy settings')
  if (saved) {
    proxySaveLabel = text('已保存', 'Saved')
  } else if (saving) {
    proxySaveLabel = text('保存中...', 'Saving...')
  }

  return (
    <div className="max-w-[480px] space-y-5">
      <div
        className="flex items-center justify-between p-4 rounded-xl"
        style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
      >
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{text('启用代理', 'Enable proxy')}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {text('所有 AI API 请求将通过代理发送', 'All AI API requests will be sent through the proxy.')}
          </p>
        </div>
        <Switch
          checked={proxy.enabled}
          onCheckedChange={(checked) => setProxy({ ...proxy, enabled: checked })}
          aria-label={text('启用代理', 'Enable proxy')}
        />
      </div>

      {proxy.enabled && (
        <div
          className="space-y-3 p-4 rounded-xl"
          style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
        >
          <div>
            <Label>{text('代理类型', 'Proxy type')}</Label>
            <NativeSelect
              value={proxy.type}
              onChange={(e) => setProxy({ ...proxy, type: e.target.value as 'http' | 'socks5' })}
            >
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </NativeSelect>
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div>
              <Label>{text('主机地址', 'Host')}</Label>
              <Input
                value={proxy.host}
                onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
                placeholder="127.0.0.1"
              />
            </div>
            <div>
              <Label>{text('端口', 'Port')}</Label>
              <Input
                type="number"
                value={proxy.port}
                onChange={(e) => setProxy({ ...proxy, port: (e.target.value === '' ? '' : parseInt(e.target.value)) as number })}
                onBlur={() => {
                  const v = Number(proxy.port);
                  if (!v) setProxy({ ...proxy, port: 7890 })
                }}
              />
            </div>
          </div>
        </div>
      )}

      <Button onClick={handleSave} disabled={saving}>
        {saved ? <Check size={13} /> : <Save size={13} />}
        {proxySaveLabel}
      </Button>
      {saveError && <p role="alert" className="text-xs" style={{ color: 'var(--color-error-text)' }}>{saveError}</p>}
    </div>
  )
}
