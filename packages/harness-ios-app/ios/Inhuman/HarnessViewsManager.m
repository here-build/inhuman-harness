#import <React/RCTComponent.h>
#import <React/RCTViewManager.h>

#import "Inhuman-Swift.h"

/**
 View-manager shims. RCT_EXPORT_MODULE and RCT_EXPORT_VIEW_PROPERTY are
 preprocessor macros with no Swift equivalent, so registration stays in Obj-C
 while the views themselves live in HarnessViews.swift.
 */

@interface HarnessSymbolManager : RCTViewManager
@end

@implementation HarnessSymbolManager

RCT_EXPORT_MODULE(HarnessSymbol)

- (UIView *)view {
  return [[HarnessSymbolView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(name, NSString)
RCT_EXPORT_VIEW_PROPERTY(pointSize, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(tintColor, UIColor)

@end

@interface HarnessMenuManager : RCTViewManager
@end

@implementation HarnessMenuManager

RCT_EXPORT_MODULE(HarnessMenu)

- (UIView *)view {
  return [[HarnessMenuView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(actions, NSArray)
RCT_EXPORT_VIEW_PROPERTY(highlight, UIColor)
RCT_EXPORT_VIEW_PROPERTY(onSelect, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPress, RCTBubblingEventBlock)

@end

@interface HarnessListManager : RCTViewManager
@end

@implementation HarnessListManager

RCT_EXPORT_MODULE(HarnessList)

- (UIView *)view {
  return [[HarnessListView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(sections, NSArray)
RCT_EXPORT_VIEW_PROPERTY(notice, NSString)
RCT_EXPORT_VIEW_PROPERTY(emptyTitle, NSString)
RCT_EXPORT_VIEW_PROPERTY(emptyDetail, NSString)
RCT_EXPORT_VIEW_PROPERTY(noticeAction, NSString)
RCT_EXPORT_VIEW_PROPERTY(onPress, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSwitch, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSwipeAction, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onMenuAction, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onNoticeAction, RCTBubblingEventBlock)

@end

@interface HarnessGlassManager : RCTViewManager
@end

@implementation HarnessGlassManager

RCT_EXPORT_MODULE(HarnessGlass)

- (UIView *)view {
  return [[HarnessGlassView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(cornerRadius, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(interactive, BOOL)
RCT_REMAP_VIEW_PROPERTY(tint, glassTint, UIColor)

@end

@interface HarnessGlassButtonManager : RCTViewManager
@end

@implementation HarnessGlassButtonManager

RCT_EXPORT_MODULE(HarnessGlassButton)

- (UIView *)view {
  return [[HarnessGlassButtonView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(title, NSString)
RCT_EXPORT_VIEW_PROPERTY(symbol, NSString)
RCT_EXPORT_VIEW_PROPERTY(prominent, BOOL)
RCT_EXPORT_VIEW_PROPERTY(destructive, BOOL)
RCT_EXPORT_VIEW_PROPERTY(size, NSString)
RCT_EXPORT_VIEW_PROPERTY(label, NSString)
RCT_REMAP_VIEW_PROPERTY(enabled, buttonEnabled, BOOL)
RCT_REMAP_VIEW_PROPERTY(tint, buttonTint, UIColor)
RCT_EXPORT_VIEW_PROPERTY(onPress, RCTBubblingEventBlock)

@end

@interface HarnessKeyboardFollowerManager : RCTViewManager
@end

@implementation HarnessKeyboardFollowerManager

RCT_EXPORT_MODULE(HarnessKeyboardFollower)

- (UIView *)view {
  return [[HarnessKeyboardFollowerView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(gap, CGFloat)

@end
