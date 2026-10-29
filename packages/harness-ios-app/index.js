import { AppRegistry } from "react-native";

import { name as appName } from "./app.json";
import "./src/crypto";
import "./src/finalization";
import { App } from "./src/app";

AppRegistry.registerComponent(appName, () => App);
