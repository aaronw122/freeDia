import "~/assets/tailwind.css";
import { createRoot } from "react-dom/client";
import { chromeStore } from "../../lib/chrome-store";
import { SettingsPage } from "../../settings/SettingsPage";

const container = document.getElementById("root");
if (container !== null) {
	createRoot(container).render(<SettingsPage store={chromeStore} />);
}
