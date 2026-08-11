const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function dateTimeParts(value: string | Date): Record<string, string> {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Object.fromEntries(
    dateTimeFormatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
}

export function formatDateTime(value: string | Date): string {
  const parts = dateTimeParts(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatTime(value: string | Date): string {
  const parts = dateTimeParts(value);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatDate(value: string | Date): string {
  const parts = dateTimeParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatCompactDateTime(value: string | Date): string {
  const parts = dateTimeParts(value);
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}
