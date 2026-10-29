import { useEffect } from "react";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { observer } from "mobx-react-lite";
import { Linking, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AttentionScreen } from "./bell.js";
import { grouped } from "./chrome.js";
import { Daemon, Opening } from "./daemon.js";
import { DialProvider, useDial } from "./dial-context.js";
import { ModelScreen } from "./model-menu.js";
import { navigationRef, openLink, type MainStackParamList, type RootParamList } from "./navigation.js";
import { ProjectsScreen } from "./projects.js";
import { SessionScreen } from "./session.js";
import { SessionsScreen } from "./sessions.js";
import { SettingsScreen } from "./settings.js";
import { ShellProvider } from "./shell.js";
import { TypeProvider } from "./type.js";

const Main = createNativeStackNavigator<MainStackParamList>();
const RootNav = createNativeStackNavigator<RootParamList>();

function MainStack() {
  return (
    <Main.Navigator
      screenOptions={{
        scrollEdgeEffects: { top: "soft" },
      }}
    >
      <Main.Screen
        name="Projects"
        component={ProjectsScreen}
        options={{
          title: "Projects",
          headerLargeTitle: true,
          headerLargeStyle: { backgroundColor: "transparent" },
        }}
      />
      <Main.Screen
        name="Sessions"
        component={SessionsScreen}
        options={{
          title: "Sessions",
          headerLargeTitle: true,
          headerLargeStyle: { backgroundColor: "transparent" },
        }}
      />
      <Main.Screen
        name="Session"
        component={SessionScreen}
        options={{
          title: "",
          headerLargeTitle: false,
          headerTransparent: true,
          scrollEdgeEffects: { top: "soft" },
        }}
      />
    </Main.Navigator>
  );
}

const sheet = { backgroundColor: grouped };

const Root = observer(function Gate() {
  const dial = useDial();
  useEffect(() => {
    void dial.follow({ kind: "kernel" });
  }, [dial]);
  const ready = dial.kernel != null;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    // The navigator mounts with the kernel; give it a frame before routing into it.
    const timer = setTimeout(() => {
      void Linking.getInitialURL().then((url) => {
        if (live && url != null) openLink(url);
        return undefined;
      });
    }, 0);
    const listener = Linking.addEventListener("url", (event) => openLink(event.url));
    return () => {
      live = false;
      clearTimeout(timer);
      listener.remove();
    };
  }, [ready]);
  if (dial.kernel == null && (dial.attaching || dial.link == null)) return <Opening />;
  if (dial.kernel == null) return <Daemon timedOut={dial.link?.kind === "unanswered"} />;
  return (
    <RootNav.Navigator>
      <RootNav.Screen name="Main" component={MainStack} options={{ headerShown: false }} />
      <RootNav.Screen
        name="Attention"
        component={AttentionScreen}
        options={{
          presentation: "pageSheet",
          title: "Attention",
          scrollEdgeEffects: { top: "hidden" },
          contentStyle: sheet,
        }}
      />
      <RootNav.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          presentation: "formSheet",
          headerShown: false,
          sheetAllowedDetents: [1],
          sheetGrabberVisible: true,
          contentStyle: sheet,
        }}
      />
      <RootNav.Screen
        name="Model"
        component={ModelScreen}
        options={{
          presentation: "pageSheet",
          title: "Model",
          scrollEdgeEffects: { top: "hidden" },
          contentStyle: sheet,
        }}
      />
    </RootNav.Navigator>
  );
});

export function App() {
  const scheme = useColorScheme();
  return (
    <DialProvider>
      <ShellProvider>
        <TypeProvider>
          <SafeAreaProvider>
            <NavigationContainer ref={navigationRef} theme={scheme === "dark" ? DarkTheme : DefaultTheme}>
              <Root />
            </NavigationContainer>
          </SafeAreaProvider>
        </TypeProvider>
      </ShellProvider>
    </DialProvider>
  );
}
