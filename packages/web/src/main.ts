import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, PieChart, BarChart, ScatterChart } from 'echarts/charts'
import { LegacyGridContainLabel } from 'echarts/features'
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent
} from 'echarts/components'
import router from './router'
import i18n from './i18n'
import App from './App.vue'
import './style.css'
import './styles/common.css'
import './styles/table.css'
import './styles/modal.css'

use([
  CanvasRenderer,
  LineChart,
  PieChart,
  BarChart,
  ScatterChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  LegacyGridContainLabel
])

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(i18n)

app.mount('#app')
