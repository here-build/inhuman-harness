import UIKit

/// The native views React renders by name: HarnessSymbol, HarnessMenu, HarnessList,
/// HarnessGlass, HarnessGlassButton.
/// The view managers that register them with React live in HarnessViewsManager.m —
/// RCT_EXPORT_MODULE and RCT_EXPORT_VIEW_PROPERTY are preprocessor macros and stay in Obj-C.

// MARK: - HarnessSymbol

/// An SF Symbol drawn at a point size, tinted by the caller.
@objc(HarnessSymbolView)
final class HarnessSymbolView: UIImageView {
  @objc var name: String = "" {
    didSet { refresh() }
  }

  @objc var pointSize: CGFloat = 17 {
    didSet { refresh() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    contentMode = .scaleAspectFit
    backgroundColor = .clear
  }

  required init?(coder: NSCoder) {
    nil
  }

  private func refresh() {
    guard !name.isEmpty else {
      image = nil
      return
    }
    let size = pointSize > 0 ? pointSize : 17
    let configuration = UIImage.SymbolConfiguration(pointSize: size, weight: .regular)
    let symbol = UIImage(systemName: name, withConfiguration: configuration)
    image = symbol?.withRenderingMode(.alwaysTemplate)
  }
}

// MARK: - HarnessMenu

/// A row that highlights on touch, opens a native context menu on long-press, and taps through.
@objc(HarnessMenuView)
final class HarnessMenuView: UIView, UIContextMenuInteractionDelegate {
  @objc var actions: NSArray?
  @objc var onSelect: RCTBubblingEventBlock?
  /// A tap is only claimed when React listens for one; otherwise links and buttons inside the view stay tappable.
  @objc var onPress: RCTBubblingEventBlock? {
    didSet { tap.isEnabled = onPress != nil }
  }
  @objc var highlight: UIColor?

  private var resting: UIColor?
  private var pressed = false {
    didSet { applyBackground() }
  }

  private var menuVisible = false
  private var menuInteraction: UIContextMenuInteraction!
  private let tap = UITapGestureRecognizer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    menuInteraction = UIContextMenuInteraction(delegate: self)
    addInteraction(menuInteraction)
    tap.addTarget(self, action: #selector(tapped))
    tap.isEnabled = false
    addGestureRecognizer(tap)
  }

  required init?(coder: NSCoder) {
    nil
  }

  override var backgroundColor: UIColor? {
    didSet {
      resting = backgroundColor
      applyBackground()
    }
  }

  private func applyBackground() {
    super.backgroundColor = pressed ? (highlight ?? resting) : resting
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesBegan(touches, with: event)
    menuVisible = false
    pressed = true
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesEnded(touches, with: event)
    pressed = false
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesCancelled(touches, with: event)
    pressed = false
  }

  @objc private func tapped() {
    pressed = false
    guard !menuVisible else { return }
    onPress?([:])
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willDisplayMenuFor configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionAnimating?
  ) {
    menuVisible = true
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let entries = actions as? [[String: Any]], !entries.isEmpty else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      let items = entries.enumerated().map { index, entry in
        let title = entry["title"] as? String ?? ""
        let action = UIAction(title: title) { _ in
          self?.onSelect?(["index": index])
        }
        if #available(iOS 16.0, *), let subtitle = entry["subtitle"] as? String, !subtitle.isEmpty {
          action.subtitle = subtitle
        }
        if (entry["destructive"] as? Bool) == true {
          action.attributes = .destructive
        }
        return action
      }
      return UIMenu(title: "", children: items)
    }
  }
}

// MARK: - HarnessGlass

/// A Liquid Glass (iOS 26+) or system-material backdrop that fills its bounds. Never takes touches:
/// React draws it behind its own content.
@objc(HarnessGlassView)
final class HarnessGlassView: UIView {
  private let effectView = UIVisualEffectView(effect: nil)

  /// Negative means capsule.
  @objc var cornerRadius: CGFloat = 0 {
    didSet { applyShape() }
  }

  @objc var interactive: Bool = false {
    didSet { applyEffect() }
  }

  @objc var glassTint: UIColor? {
    didSet { applyEffect() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    effectView.frame = bounds
    effectView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    effectView.isUserInteractionEnabled = false
    effectView.layer.cornerCurve = .continuous
    effectView.clipsToBounds = true
    addSubview(effectView)
    applyEffect()
  }

  required init?(coder: NSCoder) {
    nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    applyShape()
  }

  private func applyEffect() {
    if #available(iOS 26.0, *) {
      let glass = UIGlassEffect()
      glass.isInteractive = interactive
      glass.tintColor = glassTint
      effectView.effect = glass
    } else {
      effectView.effect = UIBlurEffect(style: .systemChromeMaterial)
      effectView.contentView.backgroundColor = glassTint?.withAlphaComponent(0.2)
    }
  }

  private func applyShape() {
    if #available(iOS 26.0, *) {
      // The glass material rounds itself; clipping would cut its edge highlight.
      effectView.clipsToBounds = false
      effectView.cornerConfiguration = cornerRadius < 0
        ? .capsule()
        : .uniformCorners(radius: .fixed(Double(cornerRadius)))
    } else {
      let side = min(bounds.width, bounds.height)
      effectView.layer.cornerRadius = cornerRadius < 0 ? side / 2 : min(cornerRadius, side / 2)
    }
  }
}

// MARK: - HarnessGlassButton

/// A system button in glass (iOS 26+) or gray/filled configuration. The size comes from React's
/// style; a symbol-only button with equal sides is a circle.
@objc(HarnessGlassButtonView)
final class HarnessGlassButtonView: UIButton {
  @objc var title: String = "" { didSet { refresh() } }
  @objc var symbol: String = "" { didSet { refresh() } }
  @objc var prominent: Bool = false { didSet { refresh() } }
  @objc var destructive: Bool = false { didSet { refresh() } }
  @objc var buttonEnabled: Bool = true { didSet { isEnabled = buttonEnabled } }
  @objc var size: String = "regular" { didSet { refresh() } }
  @objc var label: String? { didSet { refresh() } }
  @objc var onPress: RCTBubblingEventBlock?

  /// `tintColor` is reset to the tint-adjusted color when unset, so keep the caller's choice apart.
  @objc var buttonTint: UIColor? { didSet { refresh() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    addTarget(self, action: #selector(pressed), for: .primaryActionTriggered)
    refresh()
  }

  required init?(coder: NSCoder) {
    nil
  }

  @objc private func pressed() {
    onPress?([:])
  }

  private func refresh() {
    var configuration: UIButton.Configuration
    if #available(iOS 26.0, *) {
      configuration = prominent ? .prominentGlass() : .glass()
    } else {
      configuration = prominent ? .filled() : .gray()
    }
    configuration.cornerStyle = .capsule
    configuration.buttonSize = size == "large" ? .large : .medium
    configuration.imagePlacement = .leading
    configuration.imagePadding = 6
    if !title.isEmpty { configuration.title = title }
    if !symbol.isEmpty { configuration.image = UIImage(systemName: symbol) }
    if title.isEmpty {
      // Symbol-only: even padding so a square frame reads as a circle.
      configuration.contentInsets = .zero
      configuration.imagePadding = 0
    }
    self.configuration = configuration
    tintColor = buttonTint ?? (destructive ? .systemRed : nil)
    isEnabled = buttonEnabled
    accessibilityLabel = (label?.isEmpty == false) ? label : (title.isEmpty ? nil : title)
  }
}

// MARK: - HarnessList

/// A declarative inset-grouped table. System cells (UIListContentConfiguration), system
/// swipe actions (UIContextualAction), system separators, selection, and Dynamic Type.
/// A destructive swipe never commits on a full swipe: the button has to be tapped, and
/// the React side is expected to confirm destructive acts anyway.
@objc(HarnessListView)
final class HarnessListView: UITableView, UITableViewDataSource, UITableViewDelegate {
  @objc var sections: NSArray? {
    didSet {
      parsed = HarnessListParser.sections(from: sections)
      reloadData()
      updateEmpty()
    }
  }

  @objc var notice: String? {
    didSet { updateNotice() }
  }

  @objc var emptyTitle: String? {
    didSet { updateEmpty() }
  }

  @objc var emptyDetail: String? {
    didSet { updateEmpty() }
  }

  @objc var noticeAction: String? {
    didSet { updateNotice() }
  }

  @objc var onPress: RCTBubblingEventBlock?
  @objc var onSwitch: RCTBubblingEventBlock?
  @objc var onSwipeAction: RCTBubblingEventBlock?
  @objc var onMenuAction: RCTBubblingEventBlock?
  @objc var onNoticeAction: RCTBubblingEventBlock?

  private var parsed: [HarnessListParser.Section] = []

  /// The switch carries its row key; the row tap and the switch flip both reach React.
  private final class KeyedSwitch: UISwitch {
    var rowKey: String = ""
  }

  private static let rowIdentifier = "harness.row"

  /// React's view manager allocates through plain `init`, which would build a plain-style table.
  convenience init() {
    self.init(frame: .zero, style: .insetGrouped)
  }

  override init(frame: CGRect, style: UITableView.Style) {
    super.init(frame: frame, style: .insetGrouped)
    dataSource = self
    delegate = self
    rowHeight = UITableView.automaticDimension
    estimatedRowHeight = 48
    estimatedSectionHeaderHeight = 20
    estimatedSectionFooterHeight = 20
    contentInsetAdjustmentBehavior = .automatic
    keyboardDismissMode = .interactive
    sectionHeaderTopPadding = 0
    register(UITableViewCell.self, forCellReuseIdentifier: Self.rowIdentifier)
    // Accessory stacks are sized by hand, so a text-size change has to rebuild them.
    NotificationCenter.default.addObserver(
      self, selector: #selector(contentSizeChanged),
      name: UIContentSizeCategory.didChangeNotification, object: nil
    )
  }

  @objc private func contentSizeChanged() {
    reloadData()
  }

  required init?(coder: NSCoder) {
    nil
  }

  private func row(at indexPath: IndexPath) -> HarnessListParser.Row? {
    guard indexPath.section < parsed.count else { return nil }
    let section = parsed[indexPath.section]
    guard indexPath.row < section.rows.count else { return nil }
    return section.rows[indexPath.row]
  }

  // MARK: Data source

  func numberOfSections(in tableView: UITableView) -> Int {
    parsed.count
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    guard section < parsed.count else { return 0 }
    return parsed[section].rows.count
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = dequeueReusableCell(withIdentifier: Self.rowIdentifier, for: indexPath)
    guard let row = row(at: indexPath) else { return cell }

    var content = UIListContentConfiguration.cell()
    content.text = row.title
    content.secondaryText = row.detail.isEmpty ? nil : row.detail
    content.secondaryTextProperties.color = row.detailDanger ? .systemRed : .secondaryLabel
    content.secondaryTextProperties.numberOfLines = row.detailLines
    content.secondaryTextProperties.lineBreakMode = row.detailMiddle ? .byTruncatingMiddle : .byTruncatingTail
    content.textProperties.adjustsFontForContentSizeCategory = true
    content.secondaryTextProperties.adjustsFontForContentSizeCategory = true
    if !row.symbol.isEmpty {
      content.image = UIImage(systemName: row.symbol)
      content.imageProperties.tintColor = HarnessListParser.symbolColor(row.symbolTint)
      content.imageProperties.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
        scale: HarnessListParser.symbolScale(row.symbolScale)
      )
    } else if let lead = parsed[indexPath.section].rows.first(where: { !$0.symbol.isEmpty }) {
      // Keep text columns aligned: borrow a sibling's symbol, invisible, at the same configuration.
      content.image = UIImage(systemName: lead.symbol)
      content.imageProperties.tintColor = .clear
      content.imageProperties.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
        scale: HarnessListParser.symbolScale(lead.symbolScale)
      )
    }
    cell.contentConfiguration = content

    let reusableSwitch = cell.accessoryView as? KeyedSwitch
    cell.accessoryView = nil
    cell.accessoryType = .none
    if row.hasSwitch {
      let sw = reusableSwitch ?? {
        let made = KeyedSwitch()
        made.addTarget(self, action: #selector(switchChanged(_:)), for: .valueChanged)
        return made
      }()
      sw.isOn = row.switchOn
      sw.isEnabled = !row.disabled
      sw.rowKey = row.key
      cell.accessoryView = sw
    } else if row.badge > 0 || !row.value.isEmpty {
      cell.accessoryView = AccessoryStack(badge: row.badge, value: row.value, chevron: row.disclosure)
    } else {
      cell.accessoryType = if row.checked { .checkmark } else if row.disclosure { .disclosureIndicator } else { .none }
    }

    cell.selectionStyle = row.disabled ? .none : .default
    cell.isUserInteractionEnabled = !row.disabled

    if row.hasSwitch {
      // Leave the switch to VoiceOver's own label and traits.
      cell.accessibilityLabel = nil
      cell.accessibilityTraits = .none
    } else {
      var parts = [row.title]
      if !row.detail.isEmpty { parts.append(row.detail) }
      if row.badge > 0 { parts.append("\(row.badge) waiting") }
      if !row.value.isEmpty { parts.append(row.value) }
      cell.accessibilityLabel = parts.joined(separator: ", ")
      var traits: UIAccessibilityTraits = row.disabled ? .notEnabled : .button
      if row.checked { traits.insert(.selected) }
      cell.accessibilityTraits = traits
    }
    return cell
  }

  @objc private func switchChanged(_ sender: UISwitch) {
    guard let keyed = sender as? KeyedSwitch, !keyed.rowKey.isEmpty else { return }
    onSwitch?(["key": keyed.rowKey, "value": keyed.isOn])
  }

  // MARK: Section headers and footers

  private func labelView(
    _ text: String, style: UIFont.TextStyle, color: UIColor, top: CGFloat, bottom: CGFloat
  ) -> UIView {
    // Frame-managed: the table positions header/footer views itself.
    let padding = UIView()
    let label = UILabel()
    label.text = text
    label.numberOfLines = 0
    label.font = .preferredFont(forTextStyle: style)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = color
    padding.addSubview(label)
    label.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: padding.topAnchor, constant: top),
      label.bottomAnchor.constraint(equalTo: padding.bottomAnchor, constant: -bottom),
      label.leadingAnchor.constraint(equalTo: padding.leadingAnchor, constant: 12),
      label.trailingAnchor.constraint(lessThanOrEqualTo: padding.trailingAnchor, constant: -12),
    ])
    return padding
  }

  func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
    guard section < parsed.count, !parsed[section].header.isEmpty else { return nil }
    return labelView(parsed[section].header, style: .footnote, color: .secondaryLabel, top: 18, bottom: 6)
  }

  func tableView(_ tableView: UITableView, viewForFooterInSection section: Int) -> UIView? {
    guard section < parsed.count, !parsed[section].footer.isEmpty else { return nil }
    let sectionData = parsed[section]
    let color: UIColor = sectionData.footerDanger ? .systemRed : .secondaryLabel
    return labelView(sectionData.footer, style: .footnote, color: color, top: 6, bottom: 0)
  }

  func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat {
    UITableView.automaticDimension
  }

  func tableView(_ tableView: UITableView, heightForFooterInSection section: Int) -> CGFloat {
    UITableView.automaticDimension
  }

  // MARK: Selection and swipe actions

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: true)
    guard let row = row(at: indexPath), !row.disabled else { return }
    onPress?(["key": row.key])
  }

  private func swipeConfiguration(
    for swipes: [HarnessListParser.Swipe], key: String
  ) -> UISwipeActionsConfiguration? {
    guard !swipes.isEmpty, onSwipeAction != nil else { return nil }
    let actions = swipes.map { swipe in
      UIContextualAction(
        style: swipe.destructive ? .destructive : .normal,
        title: swipe.label
      ) { [weak self] _, _, completion in
        self?.onSwipeAction?(["key": key, "action": swipe.id])
        completion(true)
      }
    }
    for (action, swipe) in zip(actions, swipes) {
      action.backgroundColor = HarnessListParser.toneColor(swipe.tone)
    }
    let configuration = UISwipeActionsConfiguration(actions: actions)
    configuration.performsFirstActionWithFullSwipe = !(swipes.first?.destructive ?? false)
    return configuration
  }

  func tableView(
    _ tableView: UITableView, leadingSwipeActionsConfigurationForRowAt indexPath: IndexPath
  ) -> UISwipeActionsConfiguration? {
    guard let row = row(at: indexPath), !row.disabled else { return nil }
    return swipeConfiguration(for: row.leading, key: row.key)
  }

  func tableView(
    _ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
  ) -> UISwipeActionsConfiguration? {
    guard let row = row(at: indexPath), !row.disabled else { return nil }
    return swipeConfiguration(for: row.trailing, key: row.key)
  }

  func tableView(
    _ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let row = row(at: indexPath), !row.disabled, !row.menu.isEmpty, onMenuAction != nil else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      let items = row.menu.map { item in
        UIAction(
          title: item.title,
          image: item.symbol.isEmpty ? nil : UIImage(systemName: item.symbol),
          attributes: item.destructive ? .destructive : []
        ) { _ in
          self?.onMenuAction?(["key": row.key, "action": item.id])
        }
      }
      return UIMenu(children: items)
    }
  }

  // MARK: Notice header and empty state

  private func updateNotice() {
    let text = notice ?? ""
    let action = noticeAction ?? ""
    guard !text.isEmpty || !action.isEmpty else {
      tableHeaderView = nil
      return
    }
    let stack = UIStackView()
    stack.axis = .vertical
    stack.alignment = .leading
    stack.spacing = 2

    if !text.isEmpty {
      let label = UILabel()
      label.numberOfLines = 0
      label.font = .preferredFont(forTextStyle: .subheadline)
      label.adjustsFontForContentSizeCategory = true
      label.textColor = .secondaryLabel
      label.text = text
      stack.addArrangedSubview(label)
    }
    if !action.isEmpty {
      var configuration = UIButton.Configuration.plain()
      configuration.title = action
      configuration.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0)
      let button = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in
        self?.onNoticeAction?([:])
      })
      stack.addArrangedSubview(button)
    }

    let padding = UIView()
    padding.addSubview(stack)
    stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: padding.topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: padding.bottomAnchor, constant: -4),
      stack.leadingAnchor.constraint(equalTo: padding.leadingAnchor, constant: 32),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: padding.trailingAnchor, constant: -32),
    ])
    tableHeaderView = padding
    setNeedsLayout()
  }

  override func layoutSubviews() {
    // tableHeaderView does not self-size; measure it against the table width before the
    // table lays its sections out below it.
    if let header = tableHeaderView, bounds.width > 0 {
      let fit = header.systemLayoutSizeFitting(
        CGSize(width: bounds.width, height: UIView.layoutFittingCompressedSize.height),
        withHorizontalFittingPriority: .required,
        verticalFittingPriority: .fittingSizeLevel
      )
      if fit.height > 0, abs(header.frame.height - fit.height) > 0.5 || abs(header.frame.width - bounds.width) > 0.5 {
        header.frame = CGRect(x: 0, y: 0, width: bounds.width, height: fit.height)
        tableHeaderView = header
        // Section headers were positioned against the old header height.
        reloadData()
      }
    }
    super.layoutSubviews()
  }

  private func updateEmpty() {
    let rows = parsed.reduce(0) { $0 + $1.rows.count }
    guard rows == 0, let emptyTitle, !emptyTitle.isEmpty else {
      backgroundView = nil
      return
    }
    let title = UILabel()
    title.text = emptyTitle
    title.numberOfLines = 0
    title.textAlignment = .center
    title.font = .preferredFont(forTextStyle: .body)
    title.adjustsFontForContentSizeCategory = true
    title.textColor = .label

    let detail = UILabel()
    detail.text = emptyDetail
    detail.numberOfLines = 0
    detail.textAlignment = .center
    detail.font = .preferredFont(forTextStyle: .subheadline)
    detail.adjustsFontForContentSizeCategory = true
    detail.textColor = .secondaryLabel

    let stack = UIStackView(arrangedSubviews: [title, detail])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 6

    let container = UIView()
    container.backgroundColor = .clear
    container.addSubview(stack)
    stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 32),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -32),
    ])
    backgroundView = container
  }
}

/// Trailing cell content: [badge, value, chevron]. Replaces the system disclosure indicator,
/// so the chevron is drawn to match it.
private final class AccessoryStack: UIStackView {
  convenience init(badge: Int, value: String, chevron: Bool) {
    self.init(frame: .zero)
    axis = .horizontal
    alignment = .center
    spacing = 8

    func label(_ text: String, style: UIFont.TextStyle, color: UIColor) -> UILabel {
      let label = UILabel()
      let base = UIFont.preferredFont(forTextStyle: style)
      label.font = UIFontMetrics(forTextStyle: style)
        .scaledFont(for: .monospacedDigitSystemFont(ofSize: base.pointSize, weight: .regular))
      label.adjustsFontForContentSizeCategory = true
      label.textColor = color
      label.text = text
      label.setContentCompressionResistancePriority(.required, for: .horizontal)
      return label
    }

    if badge > 0 { addArrangedSubview(label("\(badge)", style: .body, color: .systemOrange)) }
    if !value.isEmpty { addArrangedSubview(label(value, style: .subheadline, color: .secondaryLabel)) }
    if chevron {
      let configuration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .default)
        .applying(UIImage.SymbolConfiguration(weight: .semibold))
      let view = UIImageView(image: UIImage(systemName: "chevron.forward", withConfiguration: configuration))
      view.tintColor = .tertiaryLabel
      view.setContentHuggingPriority(.required, for: .horizontal)
      addArrangedSubview(view)
    }
    layoutIfNeeded()
    frame.size = systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
  }
}

/// Value types parsed out of the dictionaries React sends over the bridge.
private enum HarnessListParser {
  struct Swipe {
    let id: String
    let label: String
    let tone: String
    var destructive: Bool { tone == "destructive" }
  }

  struct MenuItem {
    let id: String
    let title: String
    let symbol: String
    let destructive: Bool
  }

  struct Row {
    let key: String
    let title: String
    let detail: String
    let detailDanger: Bool
    let checked: Bool
    let disclosure: Bool
    let hasSwitch: Bool
    let switchOn: Bool
    let disabled: Bool
    let symbol: String
    let symbolTint: String
    let symbolScale: String
    let value: String
    let badge: Int
    let detailLines: Int
    let detailMiddle: Bool
    let menu: [MenuItem]
    let leading: [Swipe]
    let trailing: [Swipe]
  }

  struct Section {
    let header: String
    let footer: String
    let footerDanger: Bool
    let rows: [Row]
  }

  static func toneColor(_ tone: String) -> UIColor {
    switch tone {
    case "quiet": .systemOrange
    case "destructive": .systemRed
    default: .systemBlue
    }
  }

  static func symbolColor(_ name: String) -> UIColor {
    switch name {
    case "green": .systemGreen
    case "orange": .systemOrange
    case "red": .systemRed
    case "blue": .systemBlue
    case "tertiary": .tertiaryLabel
    default: .secondaryLabel
    }
  }

  static func symbolScale(_ name: String) -> UIImage.SymbolScale {
    switch name {
    case "medium": .medium
    case "large": .large
    default: .small
    }
  }

  private static func menu(_ source: [String: Any]) -> [MenuItem] {
    guard let raw = source["menu"] as? [[String: Any]] else { return [] }
    return raw.compactMap { entry in
      let id = text(entry, "id")
      let title = text(entry, "title")
      guard !id.isEmpty, !title.isEmpty else { return nil }
      return MenuItem(id: id, title: title, symbol: text(entry, "symbol"), destructive: flag(entry, "destructive"))
    }
  }

  private static func text(_ source: [String: Any], _ key: String) -> String {
    source[key] as? String ?? ""
  }

  private static func flag(_ source: [String: Any], _ key: String) -> Bool {
    source[key] as? Bool ?? false
  }

  private static func swipes(_ source: [String: Any], _ key: String) -> [Swipe] {
    guard let raw = source[key] as? [[String: Any]] else { return [] }
    var parsed: [Swipe] = []
    for entry in raw {
      let label = text(entry, "label")
      let id = text(entry, "id")
      guard !label.isEmpty, !id.isEmpty else { continue }
      parsed.append(Swipe(id: id, label: label, tone: text(entry, "tone")))
    }
    return parsed
  }

  private static func row(_ source: [String: Any]) -> Row? {
    let key = text(source, "key")
    guard !key.isEmpty else { return nil }
    return Row(
      key: key,
      title: text(source, "title"),
      detail: text(source, "detail"),
      detailDanger: flag(source, "detailDanger"),
      checked: flag(source, "checked"),
      disclosure: flag(source, "disclosure"),
      hasSwitch: source["switchOn"] is NSNumber,
      switchOn: flag(source, "switchOn"),
      disabled: flag(source, "disabled"),
      symbol: text(source, "symbol"),
      symbolTint: text(source, "symbolTint"),
      symbolScale: text(source, "symbolScale"),
      value: text(source, "value"),
      badge: (source["badge"] as? NSNumber)?.intValue ?? 0,
      detailLines: (source["detailLines"] as? NSNumber)?.intValue ?? 1,
      detailMiddle: flag(source, "detailMiddle"),
      menu: menu(source),
      leading: swipes(source, "leadingSwipe"),
      trailing: swipes(source, "trailingSwipe")
    )
  }

  static func sections(from raw: Any?) -> [Section] {
    guard let entries = raw as? [[String: Any]] else { return [] }
    return entries.map { entry in
      let rows = (entry["rows"] as? [[String: Any]] ?? []).compactMap { row($0) }
      return Section(
        header: text(entry, "header"),
        footer: text(entry, "footer"),
        footerDanger: flag(entry, "footerDanger"),
        rows: rows
      )
    }
  }
}

// MARK: - HarnessKeyboardFollower

/// Renders nothing. Lifts its React parent so the parent's bottom edge sits `gap` above the keyboard,
/// inside UIKit's own keyboard animation, so the two move on the same frames and curve with no JS in the loop.
/// The math uses the parent's layout position with our own translation removed, so React layout changes compose.
@objc(HarnessKeyboardFollowerView)
final class HarnessKeyboardFollowerView: UIView {
  @objc var gap: CGFloat = 8 {
    didSet { apply(duration: 0, options: []) }
  }

  private var keyboardTop: CGFloat?
  private var applied: CGFloat = 0
  private weak var lifted: UIView?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    backgroundColor = .clear
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  deinit { NotificationCenter.default.removeObserver(self) }

  /// The React parent, skipping the interop wrapper that hosts legacy view-manager views under Fabric.
  private var target: UIView? {
    var view = superview
    while let current = view, String(describing: type(of: current)).contains("Interop") { view = current.superview }
    return view
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { release() } else { apply(duration: 0, options: []) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    apply(duration: 0, options: [])
  }

  private func release() {
    lifted?.transform = .identity
    lifted = nil
    applied = 0
  }

  @objc private func keyboardChanged(_ note: Notification) {
    guard let window, let info = note.userInfo, let end = info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
    let frame = window.convert(end, from: window.screen.coordinateSpace)
    let covers = note.name != UIResponder.keyboardWillHideNotification && frame.height > 0 && frame.minY < window.bounds.maxY - 1
    keyboardTop = covers ? frame.minY : nil
    let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
    let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
    apply(duration: duration, options: UIView.AnimationOptions(rawValue: curve << 16))
  }

  private func apply(duration: TimeInterval, options: UIView.AnimationOptions) {
    guard let window, let parent = target else { return }
    if lifted !== parent {
      release()
      lifted = parent
    }
    var offset: CGFloat = 0
    if let top = keyboardTop {
      let bottom = parent.convert(CGPoint(x: 0, y: parent.bounds.maxY), to: window).y - applied
      offset = min(0, top - gap - bottom)
    }
    guard offset != applied else { return }
    applied = offset
    let move = { parent.transform = CGAffineTransform(translationX: 0, y: offset) }
    if duration > 0 {
      UIView.animate(withDuration: duration, delay: 0, options: options.union([.beginFromCurrentState, .allowUserInteraction]), animations: move)
    } else {
      move()
    }
  }
}
