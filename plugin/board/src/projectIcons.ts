import {
  bundleIcon,
  AirplaneFilled, AirplaneRegular, AppGenericFilled, AppGenericRegular, ArchiveFilled, ArchiveRegular, BeakerFilled, BeakerRegular,
  BookFilled, BookmarkFilled, BookmarkRegular, BookRegular, BoxFilled, BoxRegular, BrainFilled, BrainRegular, BranchFilled, BranchRegular,
  BriefcaseFilled, BriefcaseRegular, BugFilled, BugRegular, BuildingFilled, BuildingRegular, CalendarFilled, CalendarRegular,
  CameraFilled, CameraRegular, CartFilled, CartRegular, ChatFilled, ChatRegular, CloudFilled, CloudRegular, CodeFilled, CodeRegular,
  ColorFilled, ColorRegular, CubeFilled, CubeRegular, DatabaseFilled, DatabaseRegular, DataBarVerticalFilled, DataBarVerticalRegular,
  DataPieFilled, DataPieRegular, DesktopFilled, DesktopRegular, DeveloperBoardFilled, DeveloperBoardRegular, DocumentTextFilled,
  DocumentTextRegular, EditFilled, EditRegular, FlagFilled, FlagRegular, FolderFilled, FolderRegular, GamesFilled, GamesRegular,
  GlobeFilled, GlobeRegular, HatGraduationFilled, HatGraduationRegular, HeartFilled, HeartRegular, HomeFilled, HomeRegular,
  ImageFilled, ImageRegular, LaptopFilled, LaptopRegular, LeafOneFilled, LeafOneRegular, LightbulbFilled, LightbulbRegular,
  LockClosedFilled, LockClosedRegular, MailFilled, MailRegular, MathFormulaFilled, MathFormulaRegular, MicFilled, MicRegular,
  MusicNote2Filled, MusicNote2Regular, PaintBrushFilled, PaintBrushRegular, PaymentFilled, PaymentRegular, PeopleFilled, PeopleRegular,
  PhoneFilled, PhoneRegular, PuzzlePieceFilled, PuzzlePieceRegular, SearchFilled, SearchRegular, ServerFilled, ServerRegular,
  SettingsFilled, SettingsRegular, ShieldFilled, ShieldRegular, SparkleFilled, SparkleRegular, StarFilled, StarRegular,
  TableFilled, TableRegular, TagFilled, TagRegular, VideoFilled, VideoRegular, Wifi1Filled, Wifi1Regular, WindowConsoleFilled,
  WindowConsoleRegular, WrenchFilled, WrenchRegular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import { t, translated } from './i18n.ts';

/**
 * Icons a project can show in the sidebar, keyed by the SF Symbol name the macOS app draws for the same choice
 * (`ProjectSettings.icon`). Each is bundled with its filled style, which the current sidebar item shows.
 */
const ICONS: Record<string, FluentIcon> = {
  folder: bundleIcon(FolderFilled, FolderRegular),
  star: bundleIcon(StarFilled, StarRegular),
  heart: bundleIcon(HeartFilled, HeartRegular),
  bookmark: bundleIcon(BookmarkFilled, BookmarkRegular),
  flag: bundleIcon(FlagFilled, FlagRegular),
  tag: bundleIcon(TagFilled, TagRegular),
  archivebox: bundleIcon(ArchiveFilled, ArchiveRegular),
  briefcase: bundleIcon(BriefcaseFilled, BriefcaseRegular),
  house: bundleIcon(HomeFilled, HomeRegular),
  lock: bundleIcon(LockClosedFilled, LockClosedRegular),
  'apple.terminal': bundleIcon(WindowConsoleFilled, WindowConsoleRegular),
  'chevron.left.forwardslash.chevron.right': bundleIcon(CodeFilled, CodeRegular),
  hammer: bundleIcon(WrenchFilled, WrenchRegular),
  gearshape: bundleIcon(SettingsFilled, SettingsRegular),
  cpu: bundleIcon(DeveloperBoardFilled, DeveloperBoardRegular),
  'server.rack': bundleIcon(ServerFilled, ServerRegular),
  ant: bundleIcon(BugFilled, BugRegular),
  puzzlepiece: bundleIcon(PuzzlePieceFilled, PuzzlePieceRegular),
  'arrow.triangle.branch': bundleIcon(BranchFilled, BranchRegular),
  shield: bundleIcon(ShieldFilled, ShieldRegular),
  globe: bundleIcon(GlobeFilled, GlobeRegular),
  app: bundleIcon(AppGenericFilled, AppGenericRegular),
  iphone: bundleIcon(PhoneFilled, PhoneRegular),
  laptopcomputer: bundleIcon(LaptopFilled, LaptopRegular),
  desktopcomputer: bundleIcon(DesktopFilled, DesktopRegular),
  gamecontroller: bundleIcon(GamesFilled, GamesRegular),
  cloud: bundleIcon(CloudFilled, CloudRegular),
  shippingbox: bundleIcon(BoxFilled, BoxRegular),
  cube: bundleIcon(CubeFilled, CubeRegular),
  wifi: bundleIcon(Wifi1Filled, Wifi1Regular),
  brain: bundleIcon(BrainFilled, BrainRegular),
  sparkles: bundleIcon(SparkleFilled, SparkleRegular),
  'chart.bar': bundleIcon(DataBarVerticalFilled, DataBarVerticalRegular),
  'chart.pie': bundleIcon(DataPieFilled, DataPieRegular),
  'cylinder.split.1x2': bundleIcon(DatabaseFilled, DatabaseRegular),
  tablecells: bundleIcon(TableFilled, TableRegular),
  function: bundleIcon(MathFormulaFilled, MathFormulaRegular),
  magnifyingglass: bundleIcon(SearchFilled, SearchRegular),
  lightbulb: bundleIcon(LightbulbFilled, LightbulbRegular),
  flask: bundleIcon(BeakerFilled, BeakerRegular),
  'doc.text': bundleIcon(DocumentTextFilled, DocumentTextRegular),
  book: bundleIcon(BookFilled, BookRegular),
  pencil: bundleIcon(EditFilled, EditRegular),
  paintbrush: bundleIcon(PaintBrushFilled, PaintBrushRegular),
  paintpalette: bundleIcon(ColorFilled, ColorRegular),
  photo: bundleIcon(ImageFilled, ImageRegular),
  camera: bundleIcon(CameraFilled, CameraRegular),
  video: bundleIcon(VideoFilled, VideoRegular),
  'music.note': bundleIcon(MusicNote2Filled, MusicNote2Regular),
  mic: bundleIcon(MicFilled, MicRegular),
  cart: bundleIcon(CartFilled, CartRegular),
  creditcard: bundleIcon(PaymentFilled, PaymentRegular),
  'building.2': bundleIcon(BuildingFilled, BuildingRegular),
  'person.2': bundleIcon(PeopleFilled, PeopleRegular),
  envelope: bundleIcon(MailFilled, MailRegular),
  'bubble.left.and.bubble.right': bundleIcon(ChatFilled, ChatRegular),
  calendar: bundleIcon(CalendarFilled, CalendarRegular),
  graduationcap: bundleIcon(HatGraduationFilled, HatGraduationRegular),
  airplane: bundleIcon(AirplaneFilled, AirplaneRegular),
  leaf: bundleIcon(LeafOneFilled, LeafOneRegular),
};
export const DEFAULT_PROJECT_ICON = 'folder';

/** The key a project shows: its own when the board knows it, otherwise the folder, as the app falls back. */
export const shownIconKey = (key: string | undefined) => (key && Object.hasOwn(ICONS, key) ? key : DEFAULT_PROJECT_ICON);
export const projectIcon = (key: string | undefined) => ICONS[shownIconKey(key)];

export interface IconChoice { key: string; icon: FluentIcon; name: string }
/** The picker's groups, in the app's order: one row of ten each. */
export const ICON_GROUPS = translated((): { label: string; icons: IconChoice[] }[] => {
  const group = (label: string, icons: [string, string][]) => ({ label, icons: icons.map(([key, name]) => ({ key, icon: ICONS[key], name })) });
  return [
    group(t('General'), [
      ['folder', t('Folder')], ['star', t('Star')], ['heart', t('Heart')], ['bookmark', t('Bookmark')], ['flag', t('Flag')],
      ['tag', t('Tag')], ['archivebox', t('Archive')], ['briefcase', t('Briefcase')], ['house', t('Home')], ['lock', t('Lock')],
    ]),
    // "Development" rather than "Code", which already names the code icon and reads differently in Korean.
    group(t('Development'), [
      ['apple.terminal', t('Terminal')], ['chevron.left.forwardslash.chevron.right', t('Code')], ['hammer', t('Tools')],
      ['gearshape', t('Settings')], ['cpu', t('Chip')], ['server.rack', t('Server')], ['ant', t('Bug')],
      ['puzzlepiece', t('Extension')], ['arrow.triangle.branch', t('Branch')], ['shield', t('Security')],
    ]),
    group(t('Platforms'), [
      ['globe', t('Web')], ['app', t('App')], ['iphone', t('Phone')], ['laptopcomputer', t('Laptop')], ['desktopcomputer', t('Desktop')],
      ['gamecontroller', t('Game')], ['cloud', t('Cloud')], ['shippingbox', t('Package')], ['cube', t('3D')], ['wifi', t('Network')],
    ]),
    group(t('Data & AI'), [
      ['brain', t('AI')], ['sparkles', t('Sparkles')], ['chart.bar', t('Chart')], ['chart.pie', t('Pie Chart')],
      ['cylinder.split.1x2', t('Database')], ['tablecells', t('Table')], ['function', t('Math')], ['magnifyingglass', t('Search')],
      ['lightbulb', t('Idea')], ['flask', t('Lab')],
    ]),
    group(t('Content'), [
      ['doc.text', t('Document')], ['book', t('Book')], ['pencil', t('Writing')], ['paintbrush', t('Design')], ['paintpalette', t('Palette')],
      ['photo', t('Photo')], ['camera', t('Camera')], ['video', t('Video')], ['music.note', t('Music')], ['mic', t('Audio')],
    ]),
    group(t('Work'), [
      ['cart', t('Shop')], ['creditcard', t('Payments')], ['building.2', t('Company')], ['person.2', t('Team')], ['envelope', t('Mail')],
      ['bubble.left.and.bubble.right', t('Chat')], ['calendar', t('Calendar')], ['graduationcap', t('Learning')], ['airplane', t('Travel')],
      ['leaf', t('Nature')],
    ]),
  ];
});
