'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { invalidateAiAccountStatus } from '@/lib/ai/account-status-cache';
import { listTimeZones } from '@/lib/automations/time-of-day';
import {
  DEFAULT_HANDOFF_TIME_ZONE,
  DEFAULT_WEEKLY_HOURS,
  HANDOFF_PLACEHOLDERS,
  MAX_HANDOFF_MESSAGE_LENGTH,
  WEEKDAYS,
  clockToMinutes,
  parseStoredHours,
  resolveHandoffMessage,
  wallTimeToDate,
  type Weekday,
  type WeeklyHours,
} from '@/lib/ai/handoff-hours';

// Radix/Base UI Select can't use an empty-string item value, so the
// "unassigned" choice gets a sentinel that maps to null in the payload.
const UNASSIGNED = '__unassigned__';

type MessageField = 'open' | 'closed' | 'cap';

export function AiHandoff({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiHandoff');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [members, setMembers] = useState<AccountMember[]>([]);

  const [agentId, setAgentId] = useState('');
  const [timeZone, setTimeZone] = useState(DEFAULT_HANDOFF_TIME_ZONE);
  const [hours, setHours] = useState<WeeklyHours>(DEFAULT_WEEKLY_HOURS);
  // false = no hours saved/used (the open message is always sent).
  const [hoursConfigured, setHoursConfigured] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [messages, setMessages] = useState<Record<MessageField, string>>({
    open: '',
    closed: '',
    cap: '',
  });
  // datetime-local value read in the selected time zone; '' = right now.
  const [testTime, setTestTime] = useState('');

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setConfigured(Boolean(data.configured));
      if (data.configured) {
        setAgentId(data.handoff_agent_id ?? '');
        setTimeZone(data.handoff_timezone || DEFAULT_HANDOFF_TIME_ZONE);
        const stored = parseStoredHours(data.handoff_hours);
        setHours(stored ?? DEFAULT_WEEKLY_HOURS);
        setHoursConfigured(stored !== null);
        setEnabled(Boolean(data.handoff_message_enabled));
        setMessages({
          open: data.handoff_open_message ?? '',
          closed: data.handoff_closed_message ?? '',
          cap: data.handoff_cap_message ?? '',
        });
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig]);

  const zones = useMemo(
    () => listTimeZones(timeZone).sort((a, b) => a.localeCompare(b)),
    [timeZone],
  );

  const dayError = (day: Weekday): boolean => {
    const d = hours[day];
    if (!hoursConfigured || !d.open) return false;
    const s = clockToMinutes(d.start);
    const e = clockToMinutes(d.end);
    return s === null || e === null || e <= s;
  };
  const hasHoursError = WEEKDAYS.some(dayError);
  const allClosed = hoursConfigured && WEEKDAYS.every((d) => !hours[d].open);

  const setDay = (day: Weekday, patch: Partial<WeeklyHours[Weekday]>) => {
    setHours((h) => ({ ...h, [day]: { ...h[day], ...patch } }));
    setHoursConfigured(true);
  };

  const effectiveSettings = {
    timeZone,
    hours: hoursConfigured ? hours : null,
    enabled,
    openMessage: messages.open.trim(),
    closedMessage: messages.closed.trim(),
    capMessage: messages.cap.trim(),
  };

  const previewNow = testTime
    ? (wallTimeToDate(testTime, timeZone) ?? new Date())
    : new Date();
  const onModelHandoff = resolveHandoffMessage({
    settings: effectiveSettings,
    reason: 'model',
    now: previewNow,
  });
  const onCap = resolveHandoffMessage({
    settings: effectiveSettings,
    reason: 'cap',
    now: previewNow,
  });

  const handleSave = async () => {
    if (hasHoursError) {
      toast.error(t('endBeforeStart'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/handoff', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handoff_agent_id: agentId || null,
          timezone: timeZone,
          hours: hoursConfigured ? hours : null,
          message_enabled: enabled,
          open_message: messages.open,
          closed_message: messages.closed,
          cap_message: messages.cap,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        invalidateAiAccountStatus();
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  const disabled = !canEdit || !configured || saving;

  // The trigger shows this instead of the raw item value (the sentinel
  // for "unassigned", or a user id), which Base UI would otherwise print.
  const agentMember = members.find((m) => m.user_id === agentId);
  const agentLabel = agentId
    ? agentMember
      ? memberLabel(agentMember)
      : agentId
    : t('targetUnassigned');

  const messageBox = (field: MessageField, labelKey: string, descKey: string, exampleKey: string) => {
    const value = messages[field];
    return (
      <div className="space-y-2">
        <Label htmlFor={`handoff-${field}`}>{t(labelKey)}</Label>
        <p className="text-xs text-muted-foreground">{t(descKey)}</p>
        <Textarea
          id={`handoff-${field}`}
          value={value}
          onChange={(e) => setMessages((m) => ({ ...m, [field]: e.target.value }))}
          placeholder={t(exampleKey)}
          maxLength={MAX_HANDOFF_MESSAGE_LENGTH}
          rows={3}
          disabled={disabled}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t('placeholders')}</span>
            {HANDOFF_PLACEHOLDERS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={disabled}
                onClick={() =>
                  setMessages((m) => ({ ...m, [field]: `${m[field]}${m[field] && !m[field].endsWith(' ') ? ' ' : ''}${p}`.slice(0, MAX_HANDOFF_MESSAGE_LENGTH) }))
                }
                className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-foreground hover:bg-muted disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('count', { count: value.length, max: MAX_HANDOFF_MESSAGE_LENGTH })}
          </span>
        </div>
      </div>
    );
  };

  const previewBlock = (title: string, r: typeof onModelHandoff) => (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {r.send ? (
        <p className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          {r.text}
        </p>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          {t('nothingSent')}{' '}
          {!enabled ? t('reasonOff') : t('reasonBlank')}
        </p>
      )}
    </div>
  );

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnly')}
        </p>
      )}

      {!configured && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-300">
          <span>{t('needsSetup')}</span>
          {onGoToSetup && (
            <Button size="sm" variant="outline" onClick={onGoToSetup}>
              {t('goToSetup')}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('targetTitle')}</CardTitle>
            <CardDescription>{t('targetDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Select
              value={agentId || UNASSIGNED}
              onValueChange={(v) => setAgentId(!v || v === UNASSIGNED ? '' : v)}
              disabled={disabled}
            >
              <SelectTrigger id="handoff-agent" aria-label={t('targetTitle')}>
                <SelectValue>{agentLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>{t('targetUnassigned')}</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {memberLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('hoursTitle')}</CardTitle>
            <CardDescription>{t('hoursDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!hoursConfigured && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-300">
                <span className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {t('hoursNotSet')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setHoursConfigured(true)}
                >
                  {t('hoursNotSetCta')}
                </Button>
              </div>
            )}
            {allClosed && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t('allClosed')}
              </div>
            )}

            <div className="max-w-sm space-y-2">
              <Label htmlFor="handoff-tz">{t('timeZone')}</Label>
              <Select
                value={timeZone}
                onValueChange={(v) => v && setTimeZone(v)}
                disabled={disabled}
              >
                <SelectTrigger id="handoff-tz">
                  <SelectValue>{timeZone.replace(/_/g, ' ')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {zones.map((z) => (
                    <SelectItem key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="divide-y divide-border rounded-md border border-border">
              {WEEKDAYS.map((day) => {
                const d = hours[day];
                const rowDisabled = disabled || !hoursConfigured;
                return (
                  <div key={day} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="w-24 text-sm font-medium text-foreground">
                        {t(`days.${day}`)}
                      </span>
                      <Switch
                        checked={hoursConfigured && d.open}
                        onCheckedChange={(v) => setDay(day, { open: v })}
                        disabled={disabled}
                        aria-label={`${t(`days.${day}`)}: ${t('open')}`}
                      />
                      <span className="w-14 text-xs text-muted-foreground">
                        {hoursConfigured && d.open ? t('open') : t('closed')}
                      </span>
                      <Input
                        type="time"
                        value={d.start}
                        onChange={(e) => setDay(day, { start: e.target.value })}
                        disabled={rowDisabled || !d.open}
                        aria-label={`${t(`days.${day}`)}: ${t('opensAt')}`}
                        aria-invalid={dayError(day)}
                        className="w-32"
                      />
                      <span className="text-xs text-muted-foreground">–</span>
                      <Input
                        type="time"
                        value={d.end}
                        onChange={(e) => setDay(day, { end: e.target.value })}
                        disabled={rowDisabled || !d.open}
                        aria-label={`${t(`days.${day}`)}: ${t('closesAt')}`}
                        aria-invalid={dayError(day)}
                        className="w-32"
                      />
                    </div>
                    {dayError(day) && (
                      <p className="mt-1 text-xs text-destructive">{t('endBeforeStart')}</p>
                    )}
                  </div>
                );
              })}
            </div>

            {hoursConfigured && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => setHoursConfigured(false)}
              >
                {t('clearHours')}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('messageTitle')}</CardTitle>
            <CardDescription>{t('messageDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('sendToggle')}</p>
                <p className="text-xs text-muted-foreground">{t('sendToggleDesc')}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={disabled} />
            </div>
            {messageBox('open', 'openMessage', 'openMessageDesc', 'openExample')}
            {messageBox('closed', 'closedMessage', 'closedMessageDesc', 'closedExample')}
            {messageBox('cap', 'capMessage', 'capMessageDesc', 'capExample')}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('previewTitle')}</CardTitle>
            <CardDescription>{t('previewDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label htmlFor="handoff-test-time">{t('testTime')}</Label>
                <Input
                  id="handoff-test-time"
                  type="datetime-local"
                  value={testTime}
                  onChange={(e) => setTestTime(e.target.value)}
                  className="w-56"
                />
              </div>
              {testTime && (
                <Button variant="ghost" size="sm" onClick={() => setTestTime('')}>
                  {t('useNow')}
                </Button>
              )}
              <Badge variant={onModelHandoff.hoursMissing || onModelHandoff.open ? 'default' : 'secondary'}>
                {onModelHandoff.hoursMissing
                  ? t('statusNoHours')
                  : onModelHandoff.open
                    ? t('statusOpen')
                    : t('statusClosed')}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('testTimeHint', { zone: timeZone.replace(/_/g, ' ') })}
            </p>
            {previewBlock(t('wouldSend'), onModelHandoff)}
            {previewBlock(t('wouldSendCap'), onCap)}
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={disabled || hasHoursError}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
