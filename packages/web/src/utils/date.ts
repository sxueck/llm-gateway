import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'

dayjs.locale('zh-cn')

export function formatDateTime(timestamp: number): string {
  return dayjs(timestamp).format('YYYY/MM/DD HH:mm')
}

export function formatDate(timestamp: number): string {
  return dayjs(timestamp).format('YYYY/MM/DD')
}

export function formatTime(timestamp: number): string {
  return dayjs(timestamp).format('HH:mm:ss')
}
