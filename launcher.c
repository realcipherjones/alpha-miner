/* Portable Windows x64 installer & launcher for Chrome standalone desktop app; no CRT required. */
#include "build/version.h"
typedef unsigned short W;
typedef unsigned int D;
typedef int HRESULT;
typedef unsigned long long U;
typedef void *H;

typedef struct {
 D Data1;
 unsigned short Data2;
 unsigned short Data3;
 unsigned char Data4[8];
} GUID;

typedef struct IShellLinkW IShellLinkW;
typedef struct IPersistFile IPersistFile;

typedef struct {
 HRESULT (*QueryInterface)(IShellLinkW*, const GUID*, void**);
 D (*AddRef)(IShellLinkW*);
 D (*Release)(IShellLinkW*);
 HRESULT (*GetPath)(IShellLinkW*, W*, int, void*, D);
 HRESULT (*GetIDList)(IShellLinkW*, void**);
 HRESULT (*SetIDList)(IShellLinkW*, const void*);
 HRESULT (*GetDescription)(IShellLinkW*, W*, int);
 HRESULT (*SetDescription)(IShellLinkW*, const W*);
 HRESULT (*GetWorkingDirectory)(IShellLinkW*, W*, int);
 HRESULT (*SetWorkingDirectory)(IShellLinkW*, const W*);
 HRESULT (*GetArguments)(IShellLinkW*, W*, int);
 HRESULT (*SetArguments)(IShellLinkW*, const W*);
 HRESULT (*GetHotkey)(IShellLinkW*, unsigned short*);
 HRESULT (*SetHotkey)(IShellLinkW*, unsigned short);
 HRESULT (*GetShowCmd)(IShellLinkW*, int*);
 HRESULT (*SetShowCmd)(IShellLinkW*, int);
 HRESULT (*GetIconLocation)(IShellLinkW*, W*, int, int*);
 HRESULT (*SetIconLocation)(IShellLinkW*, const W*, int);
 HRESULT (*SetRelativePath)(IShellLinkW*, const W*, D);
 HRESULT (*Resolve)(IShellLinkW*, H, D);
 HRESULT (*SetPath)(IShellLinkW*, const W*);
} IShellLinkWVtbl;

struct IShellLinkW {
 const IShellLinkWVtbl *lpVtbl;
};

typedef struct {
 HRESULT (*QueryInterface)(IPersistFile*, const GUID*, void**);
 D (*AddRef)(IPersistFile*);
 D (*Release)(IPersistFile*);
 HRESULT (*GetClassID)(IPersistFile*, GUID*);
 HRESULT (*IsDirty)(IPersistFile*);
 HRESULT (*Load)(IPersistFile*, const W*, D);
 HRESULT (*Save)(IPersistFile*, const W*, int);
 HRESULT (*SaveCompleted)(IPersistFile*, const W*);
 HRESULT (*GetCurFile)(IPersistFile*, W**);
} IPersistFileVtbl;

struct IPersistFile {
 const IPersistFileVtbl *lpVtbl;
};

static const GUID CLSID_ShellLink_GUID = {0x00021401,0x0000,0x0000,{0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46}};
static const GUID IID_IShellLinkW_GUID = {0x000214F9,0x0000,0x0000,{0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46}};
static const GUID IID_IPersistFile_GUID = {0x0000010B,0x0000,0x0000,{0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46}};

extern D GetEnvironmentVariableW(const W*,W*,D);
extern int CreateDirectoryW(const W*,void*);
extern D GetFileAttributesW(const W*);
extern H CreateFileW(const W*,D,D,void*,D,D,H);
extern int WriteFile(H,const void*,D,D*,void*);
extern int CloseHandle(H);
extern void ExitProcess(D);
extern int MessageBoxW(H,const W*,const W*,D);
extern H ShellExecuteW(H,const W*,const W*,const W*,const W*,int);
extern W *GetCommandLineW(void);
extern int UrlCreateFromPathW(const W*,W*,D*,D);
extern int RegGetValueW(H,const W*,const W*,D,D*,void*,D*);
extern HRESULT SHGetFolderPathW(H,int,H,D,W*);
extern HRESULT CoInitializeEx(void*,D);
extern void CoUninitialize(void);
extern HRESULT CoCreateInstance(const GUID*,void*,D,const GUID*,void**);
extern const unsigned char payload_start[],payload_end[];

static W root[32768],folder[32768],path[32768],iconPath[32768],browser[32768],args[32768],url[32768],shortcutDir[32768],shortcutPath[32768];

static D length(const W*s){D n=0;while(s[n])n++;return n;}
static void copy(W*d,const W*s){while((*d++=*s++));}
static void append(W*d,const W*s){copy(d+length(d),s);}
static int equals(const W*a,const W*b){while(*a && *a==*b){a++;b++;}return *a==*b;}
static int exists(const W*p){D a=GetFileAttributesW(p);return a!=0xffffffff && !(a&16);}
static void fail(const W*s){MessageBoxW(0,s,L"Alpha Miner",0x10);ExitProcess(1);}
static void directory(const W*p){if(!CreateDirectoryW(p,0) && !(GetFileAttributesW(p)!=0xffffffff && (GetFileAttributesW(p)&16)))fail(L"Could not create the game folder in Local AppData.");}
static D read32(const unsigned char*p){return (D)p[0]|((D)p[1]<<8)|((D)p[2]<<16)|((D)p[3]<<24);}
static int has(const W*s,const W*needle){for(;*s;s++){D i=0;while(needle[i] && s[i]==needle[i])i++;if(!needle[i])return 1;}return 0;}

static void writeFileBytes(const W*dest,const unsigned char*data,D size){
 H file=CreateFileW(dest,0x40000000,1,0,2,0x80,0);
 if(file==(H)(U)-1)fail(L"Could not unpack the game files into Local AppData.");
 D written=0;int ok=WriteFile(file,data,size,&written,0);CloseHandle(file);
 if(!ok||written!=size)fail(L"Could not save all game files. Check available disk space.");
}

static int findBrowserEnv(const W*env,const W*suffix){
 D n=GetEnvironmentVariableW(env,browser,30000);
 if(!n||n>=30000)return 0;
 append(browser,suffix);
 return exists(browser);
}

static int findBrowserRegistry(H hkey){
 D bytes=60000;
 if(RegGetValueW(hkey,L"Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",0,2,0,browser,&bytes)!=0)return 0;
 return exists(browser);
}

static int findChrome(void){
 return findBrowserEnv(L"ProgramFiles",L"\\Google\\Chrome\\Application\\chrome.exe") ||
        findBrowserEnv(L"ProgramFiles(x86)",L"\\Google\\Chrome\\Application\\chrome.exe") ||
        findBrowserEnv(L"LOCALAPPDATA",L"\\Google\\Chrome\\Application\\chrome.exe") ||
        findBrowserRegistry((H)(U)0xffffffff80000001ULL) || /* HKEY_CURRENT_USER */
        findBrowserRegistry((H)(U)0xffffffff80000002ULL);   /* HKEY_LOCAL_MACHINE */
}

static int createShortcutFile(const W*lnkPath){
 IShellLinkW *sl=0;
 IPersistFile *pf=0;
 if(CoCreateInstance(&CLSID_ShellLink_GUID,0,1,&IID_IShellLinkW_GUID,(void**)&sl)<0 || !sl)return 0;
 sl->lpVtbl->SetPath(sl,browser);
 sl->lpVtbl->SetArguments(sl,args);
 sl->lpVtbl->SetWorkingDirectory(sl,folder);
 sl->lpVtbl->SetIconLocation(sl,iconPath,0);
 sl->lpVtbl->SetDescription(sl,L"Alpha Miner — Chrome Standalone Desktop App");
 sl->lpVtbl->SetShowCmd(sl,1);
 int saved=0;
 if(sl->lpVtbl->QueryInterface(sl,&IID_IPersistFile_GUID,(void**)&pf)>=0 && pf){
  if(pf->lpVtbl->Save(pf,lnkPath,1)>=0)saved=1;
  pf->lpVtbl->Release(pf);
 }
 sl->lpVtbl->Release(sl);
 return saved;
}

static int resolveSpecialFolder(int csidl,const W*fallbackEnv,const W*fallbackSuffix){
 if(SHGetFolderPathW(0,csidl,0,0,shortcutDir)>=0 && shortcutDir[0])return 1;
 D n=GetEnvironmentVariableW(fallbackEnv,shortcutDir,30000);
 if(!n||n>=30000)return 0;
 append(shortcutDir,fallbackSuffix);
 return 1;
}

static void installShortcuts(void){
 HRESULT hr=CoInitializeEx(0,2); /* COINIT_APARTMENTTHREADED */
 /* CSIDL_DESKTOPDIRECTORY = 0x0010 */
 if(resolveSpecialFolder(0x0010,L"USERPROFILE",L"\\Desktop")){
  copy(shortcutPath,shortcutDir);
  append(shortcutPath,L"\\Alpha Miner.lnk");
  createShortcutFile(shortcutPath);
 }
 /* CSIDL_PROGRAMS = 0x0002 (Start Menu\Programs) */
 if(resolveSpecialFolder(0x0002,L"APPDATA",L"\\Microsoft\\Windows\\Start Menu\\Programs")){
  copy(shortcutPath,shortcutDir);
  append(shortcutPath,L"\\Alpha Miner.lnk");
  createShortcutFile(shortcutPath);
 }
 if(hr>=0)CoUninitialize();
}

void entry(void){
 D n=GetEnvironmentVariableW(L"LOCALAPPDATA",root,4096);
 if(!n||n>=4096)fail(L"Windows Local AppData is unavailable.");
 append(root,L"\\DwarfOreToss");directory(root);
 copy(folder,root);append(folder,L"\\" CONTENT_VERSION);directory(folder);
 copy(iconPath,root);append(iconPath,L"\\icon.ico");
 const unsigned char*p=payload_start;
 while(p+8<=payload_end){
  D nl=read32(p),size=read32(p+4);p+=8;
  if(!nl)break;
  if(nl>240 || p+nl+size>payload_end)fail(L"The game package is damaged. Please copy it again.");
  copy(path,folder);append(path,L"\\");D pos=length(path);
  for(D i=0;i<nl;i++){
   W c=(W)p[i];
   if(c==L'/')c=L'\\';
   path[pos+i]=c;
  }
  for(D i=0;path[pos+i];i++){
   if(path[pos+i]==L'\\'){
    path[pos+i]=0;
    directory(path);
    path[pos+i]=L'\\';
   }
  }
  p+=nl;
  writeFileBytes(path,p,size);
  if(equals(path+pos,L"icon.ico"))writeFileBytes(iconPath,p,size);
  p+=size;
 }
 /* Diagnostic packaging check: unpack without opening a browser. */
 W *cmd=GetCommandLineW();
 if(has(cmd,L"--extract-only"))ExitProcess(0);
 if(!findChrome())
   fail(L"Google Chrome is required to install and play Alpha Miner. Install Google Chrome, then run this installer again.");
 copy(path,folder);append(path,L"\\index.html");
 D urlLength=32768;
 if(UrlCreateFromPathW(path,url,&urlLength,0)<0)fail(L"Could not create the local game URL.");
 copy(args,L"--app=\"");append(args,url);
 append(args,L"\" --start-fullscreen --no-first-run --no-default-browser-check --disable-features=Translate --user-data-dir=\"");
 append(args,root);append(args,L"\\ChromeProfile\"");
 installShortcuts();
 if(has(cmd,L"--install-only")){
  MessageBoxW(0,L"Alpha Miner has been installed as a Chrome standalone desktop app.\n\nShortcuts have been added to your Desktop and Start Menu.",L"Alpha Miner",0x40);
  ExitProcess(0);
 }
 H result=ShellExecuteW(0,L"open",browser,args,folder,1);
 if((U)result<=32)fail(L"Windows could not start Google Chrome.");
 ExitProcess(0);
}
