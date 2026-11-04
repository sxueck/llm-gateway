// 常用 IANA 时区；不在列表内的时区可在下拉框直接输入（tag 模式），由后端校验。
export const COMMON_IANA_TIMEZONES: string[] = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Bangkok', 'Asia/Jakarta',
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Europe/London',
  'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Europe/Amsterdam',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland',
  'UTC',
];

export const COMMON_IANA_TIMEZONE_OPTIONS = COMMON_IANA_TIMEZONES.map(tz => ({ label: tz, value: tz }));
