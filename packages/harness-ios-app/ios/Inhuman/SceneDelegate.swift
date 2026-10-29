import UIKit
import React

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Under the scene lifecycle UIKit no longer puts the launch URL in launchOptions, which is
    // the only place RCTLinkingManager reads it for Linking.getInitialURL().
    var launchOptions = appDelegate.launchOptions ?? [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }
    #if DEBUG
      // `SIMCTL_CHILD_INHUMAN_URL=inhuman://… xcrun simctl launch` opens a screen without the
      // system "Open in Inhuman?" prompt that `simctl openurl` raises.
      if let raw = ProcessInfo.processInfo.environment["INHUMAN_URL"], let url = URL(string: raw) {
        launchOptions[.url] = url
      }
    #endif
    appDelegate.reactNativeFactory?.startReactNative(
      withModuleName: "Inhuman",
      in: window,
      launchOptions: launchOptions
    )
  }

  /// Links opened while the app is running or suspended.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      RCTLinkingManager.application(UIApplication.shared, open: context.url, options: [:])
    }
  }
}
