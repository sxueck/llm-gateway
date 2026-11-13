import {
  Activity,
  Box,
  FlaskConical,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  RefreshCw,
  Route,
  Search,
  Server,
  SlidersHorizontal,
  SquareTerminal,
} from 'lucide-vue-next';

export const NAV_GLYPHS = {
  dashboard: LayoutGrid,
  providers: Server,
  models: Box,
  routing: Route,
  keys: KeyRound,
  monitoring: Activity,
  experimental: FlaskConical,
  tools: SquareTerminal,
  settings: SlidersHorizontal,
  search: Search,
  refresh: RefreshCw,
  logout: LogOut,
  menu: Menu,
} as const;

export type NavIconName = keyof typeof NAV_GLYPHS;
