#import <React/RCTComponent.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTViewManager.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

/// Hardware chords for an armed approval, text metrics, and the last open place.
/// Command-Return allows and Command-Delete denies only while the cover is armed,
/// so a draft never treats that chord as text.
@interface HarnessHost : RCTEventEmitter
+ (void)emit:(NSString *)name;
+ (NSDictionary *)textFaces;
@end

static NSString *HarnessWeight(UIFont *font) {
  NSDictionary *traits = [font.fontDescriptor objectForKey:UIFontDescriptorTraitsAttribute];
  CGFloat weight = 0;
  if ([traits isKindOfClass:[NSDictionary class]]) {
    NSNumber *value = traits[UIFontWeightTrait];
    if ([value isKindOfClass:[NSNumber class]]) weight = value.doubleValue;
  }
  if (weight >= 0.35) return @"700";
  if (weight >= 0.23) return @"600";
  if (weight >= 0.15) return @"500";
  return @"400";
}


@implementation HarnessHost {
}

static HarnessHost *sharedHost;
static BOOL observing = NO;
static BOOL commandArmed = NO;
static NSString *const HarnessPlaceKey = @"inhuman.place";

typedef void (*PressesIMP)(id, SEL, NSSet<UIPress *> *, UIPressesEvent *);
static PressesIMP originalPressesBegan = NULL;

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (instancetype)init {
  if (self = [super init]) sharedHost = self;
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self name:UIContentSizeCategoryDidChangeNotification object:nil];
}

- (dispatch_queue_t)methodQueue {
  return dispatch_get_main_queue();
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"keyCommand", @"contentSize" ];
}

- (void)startObserving {
  observing = YES;
  NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
  [center removeObserver:self name:UIContentSizeCategoryDidChangeNotification object:nil];
  [center addObserver:self selector:@selector(contentSizeChanged) name:UIContentSizeCategoryDidChangeNotification object:nil];
}

- (void)stopObserving {
  observing = NO;
  [[NSNotificationCenter defaultCenter] removeObserver:self name:UIContentSizeCategoryDidChangeNotification object:nil];
}

- (void)contentSizeChanged {
  if (!observing) return;
  [self sendEventWithName:@"contentSize" body:[HarnessHost textFaces]];
}

+ (NSDictionary *)faceForStyle:(UIFontTextStyle)style {
  UIFont *font = [UIFont preferredFontForTextStyle:style];
  return @{
    @"fontSize" : @(font.pointSize),
    @"lineHeight" : @(font.lineHeight),
    @"fontWeight" : HarnessWeight(font),
  };
}

+ (NSDictionary *)textFaces {
  return @{
    @"body" : [self faceForStyle:UIFontTextStyleBody],
    @"headline" : [self faceForStyle:UIFontTextStyleHeadline],
    @"subhead" : [self faceForStyle:UIFontTextStyleSubheadline],
    @"footnote" : [self faceForStyle:UIFontTextStyleFootnote],
    @"callout" : [self faceForStyle:UIFontTextStyleCallout],
  };
}

+ (void)emit:(NSString *)name {
  if (!observing || sharedHost == nil) return;
  [sharedHost sendEventWithName:@"keyCommand" body:@{@"name" : name}];
}

RCT_EXPORT_METHOD(setArmed : (BOOL)armed) {
  commandArmed = armed;
}

RCT_EXPORT_METHOD(impact) {
  UIImpactFeedbackGenerator *generator =
      [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
  [generator prepare];
  [generator impactOccurred];
}

RCT_EXPORT_METHOD(textStyles : (RCTPromiseResolveBlock)resolve rejecter : (__unused RCTPromiseRejectBlock)reject) {
  resolve([HarnessHost textFaces]);
}

RCT_EXPORT_METHOD(remember : (NSString *)json) {
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  if (json.length == 0) [defaults removeObjectForKey:HarnessPlaceKey];
  else [defaults setObject:json forKey:HarnessPlaceKey];
}

RCT_EXPORT_METHOD(recall : (RCTPromiseResolveBlock)resolve rejecter : (__unused RCTPromiseRejectBlock)reject) {
  NSString *stored = [[NSUserDefaults standardUserDefaults] stringForKey:HarnessPlaceKey];
  resolve(stored == nil ? @"" : stored);
}

static BOOL harnessTakeCommand(NSSet<UIPress *> *presses) {
  if (!commandArmed) return NO;
  for (UIPress *press in presses) {
    UIKey *key = press.key;
    if (key == nil) continue;
    UIKeyModifierFlags flags = key.modifierFlags;
    if ((flags & UIKeyModifierCommand) == 0) continue;
    if ((flags & (UIKeyModifierShift | UIKeyModifierAlternate | UIKeyModifierControl)) != 0) continue;
    if (key.keyCode == UIKeyboardHIDUsageKeyboardReturn) {
      [HarnessHost emit:@"allow"];
      return YES;
    }
    if (key.keyCode == UIKeyboardHIDUsageKeyboardDeleteOrBackspace) {
      [HarnessHost emit:@"deny"];
      return YES;
    }
  }
  return NO;
}

static void harnessPressesBegan(id self, SEL command, NSSet<UIPress *> *presses, UIPressesEvent *event) {
  if (harnessTakeCommand(presses)) return;
  if (originalPressesBegan != NULL) originalPressesBegan(self, command, presses, event);
}

@end

static void harnessInstallPresses(void) __attribute__((constructor));
static void harnessInstallPresses(void) {
  Class window = [UIWindow class];
  SEL selector = @selector(pressesBegan:withEvent:);
  Method method = class_getInstanceMethod(window, selector);
  if (method == NULL) return;
  originalPressesBegan = (PressesIMP)method_getImplementation(method);
  const char *encoding = method_getTypeEncoding(method);
  if (!class_addMethod(window, selector, (IMP)harnessPressesBegan, encoding)) {
    method_setImplementation(class_getInstanceMethod(window, selector), (IMP)harnessPressesBegan);
  }
}

// MARK: - Document cache

#import <CommonCrypto/CommonDigest.h>
#import <React/RCTBridgeModule.h>

/// Yjs room documents kept between launches, under Library/Caches so the system may purge them.
/// One append-only log per key: records of a big-endian u32 length and that many bytes.
/// All disk work runs on one serial background queue, so reads see earlier writes in order
/// and the main thread never waits on a file. Past the size cap whole keys go, least
/// recently touched first.
@interface HarnessDocs : NSObject <RCTBridgeModule>
@end

static const unsigned long long HarnessDocsCap = 300ull * 1024 * 1024;

@implementation HarnessDocs {
  dispatch_queue_t _queue;
  NSString *_root;
  NSUInteger _writes;
}

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  if (self = [super init]) {
    _queue = dispatch_queue_create("tools.inhuman.docs", DISPATCH_QUEUE_SERIAL);
    NSString *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
    _root = [caches stringByAppendingPathComponent:@"inhuman-docs"];
    [[NSFileManager defaultManager] createDirectoryAtPath:_root withIntermediateDirectories:YES attributes:nil error:nil];
    dispatch_async(_queue, ^{
      [self evictIfNeeded];
    });
  }
  return self;
}

- (dispatch_queue_t)methodQueue {
  return _queue;
}

- (NSString *)pathForKey:(NSString *)key {
  NSData *data = [key dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *name = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2 + 4];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [name appendFormat:@"%02x", digest[i]];
  [name appendString:@".log"];
  return [_root stringByAppendingPathComponent:name];
}

- (void)evictIfNeeded {
  NSFileManager *files = [NSFileManager defaultManager];
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
  unsigned long long total = 0;
  for (NSString *name in [files contentsOfDirectoryAtPath:_root error:nil]) {
    NSString *path = [_root stringByAppendingPathComponent:name];
    NSDictionary *attributes = [files attributesOfItemAtPath:path error:nil];
    if (attributes == nil) continue;
    total += attributes.fileSize;
    [entries addObject:@{ @"path" : path, @"size" : @(attributes.fileSize), @"date" : attributes.fileModificationDate ?: [NSDate distantPast] }];
  }
  if (total <= HarnessDocsCap) return;
  [entries sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    return [a[@"date"] compare:b[@"date"]];
  }];
  for (NSDictionary *entry in entries) {
    if (total <= HarnessDocsCap) break;
    [files removeItemAtPath:entry[@"path"] error:nil];
    total -= [entry[@"size"] unsignedLongLongValue];
  }
}

/// The whole log as base64; reading counts as use for eviction. The caller splits the records.
RCT_EXPORT_METHOD(read : (NSString *)key resolver : (RCTPromiseResolveBlock)resolve rejecter : (__unused RCTPromiseRejectBlock)reject) {
  NSString *path = [self pathForKey:key];
  NSData *data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:nil];
  if (data == nil) {
    resolve([NSNull null]);
    return;
  }
  [[NSFileManager defaultManager] setAttributes:@{ NSFileModificationDate : [NSDate date] } ofItemAtPath:path error:nil];
  resolve([data base64EncodedStringWithOptions:0]);
}

RCT_EXPORT_METHOD(append : (NSString *)key base64 : (NSString *)base64 resolver : (RCTPromiseResolveBlock)resolve rejecter : (__unused RCTPromiseRejectBlock)reject) {
  NSData *update = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
  if (update == nil) {
    resolve(@NO);
    return;
  }
  NSString *path = [self pathForKey:key];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    [[NSFileManager defaultManager] createFileAtPath:path contents:nil attributes:nil];
  }
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  if (handle == nil) {
    resolve(@NO);
    return;
  }
  uint32_t length = CFSwapInt32HostToBig((uint32_t)update.length);
  NSMutableData *record = [NSMutableData dataWithCapacity:update.length + 4];
  [record appendBytes:&length length:4];
  [record appendData:update];
  @try {
    [handle seekToEndOfFile];
    [handle writeData:record];
  } @catch (NSException *exception) {
    resolve(@NO);
    return;
  } @finally {
    [handle closeFile];
  }
  if (++_writes % 50 == 0) [self evictIfNeeded];
  resolve(@YES);
}

/// Swap the whole log for one record, atomically, so a kill mid-write keeps the old log.
RCT_EXPORT_METHOD(replace : (NSString *)key base64 : (NSString *)base64 resolver : (RCTPromiseResolveBlock)resolve rejecter : (__unused RCTPromiseRejectBlock)reject) {
  NSData *state = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
  if (state == nil) {
    resolve(@NO);
    return;
  }
  uint32_t length = CFSwapInt32HostToBig((uint32_t)state.length);
  NSMutableData *record = [NSMutableData dataWithCapacity:state.length + 4];
  [record appendBytes:&length length:4];
  [record appendData:state];
  BOOL written = [record writeToFile:[self pathForKey:key] options:NSDataWritingAtomic error:nil];
  [self evictIfNeeded];
  resolve(@(written));
}

RCT_EXPORT_METHOD(drop : (NSString *)key resolver : (RCTPromiseResolveBlock)resolve rejecter : (__unused RCTPromiseRejectBlock)reject) {
  [[NSFileManager defaultManager] removeItemAtPath:[self pathForKey:key] error:nil];
  resolve(@YES);
}

@end
