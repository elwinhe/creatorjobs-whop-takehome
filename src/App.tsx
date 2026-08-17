import { AppShell } from './components/AppShell'
import { DashboardScreen } from './screens/DashboardScreen'
import { MarketplaceScreen } from './screens/MarketplaceScreen'
import { OrderScreen } from './screens/OrderScreen'
import { SellerScreen } from './screens/SellerScreen'

function App() {
  const path = window.location.pathname
  const orderMatch = path.match(/^\/orders\/([^/]+)$/)
  let screen = <MarketplaceScreen />
  if (path === '/seller') screen = <SellerScreen />
  else if (path === '/dashboard') screen = <DashboardScreen />
  else if (orderMatch?.[1]) screen = <OrderScreen id={orderMatch[1]} />

  return <AppShell>{screen}</AppShell>
}

export default App
