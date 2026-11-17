import { ScrollRestoration } from "react-router";
import { HomeProvider } from "./home/HomeProvider";
import Shell from "./home/Shell";

export default function App() {
  return (
    <HomeProvider>
      <Shell />
      <ScrollRestoration />
    </HomeProvider>
  );
}
