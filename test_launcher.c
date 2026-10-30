/* Host-side API simulation: tests installer, nested folder unpacking, shortcut creation, and Chrome standalone app launch logic. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "launcher.c"

static int files=0,dirs=0,launched=0,desktopShortcut=0,startMenuShortcut=0,comInit=0;
static U bytes=0;
static const char*mode;

static void narrow(char*d,const W*s){while(*s)*d++=(char)*s++;*d=0;}

D GetEnvironmentVariableW(const W*name,W*out,D cap){
 (void)cap;
 char v[100];narrow(v,name);
 if(!strcmp(v,"LOCALAPPDATA"))copy(out,L"C:\\Users\\Test Player\\AppData\\Local");
 else if(!strcmp(v,"ProgramFiles"))copy(out,L"C:\\Program Files");
 else if(!strcmp(v,"ProgramFiles(x86)"))return 0;
 else if(!strcmp(v,"USERPROFILE"))copy(out,L"C:\\Users\\Test Player");
 else if(!strcmp(v,"APPDATA"))copy(out,L"C:\\Users\\Test Player\\AppData\\Roaming");
 else abort();
 return length(out);
}

int CreateDirectoryW(const W*p,void*q){
 (void)q;
 assert(has(p,L"DwarfOreToss"));
 dirs++;
 return 1;
}

D GetFileAttributesW(const W*p){
 if(!strcmp(mode,"missing-chrome"))return 0xffffffff;
 if(!strcmp(mode,"registry-chrome"))return has(p,L"CustomChrome\\chrome.exe")?0x80:0xffffffff;
 return has(p,L"Google\\Chrome\\Application\\chrome.exe")?0x80:0xffffffff;
}

int RegGetValueW(H hkey,const W*subkey,const W*val,D flags,D*type,void*data,D*cb){
 (void)hkey;(void)val;(void)flags;(void)type;
 assert(has(subkey,L"App Paths\\chrome.exe"));
 if(!strcmp(mode,"registry-chrome")){
  copy((W*)data,L"D:\\CustomChrome\\chrome.exe");
  *cb=(length((W*)data)+1)*2;
  return 0;
 }
 return 2;
}

H CreateFileW(const W*p,D a,D share,void*sec,D disposition,D attrs,H t){
 (void)share;(void)sec;(void)attrs;(void)t;
 assert(a==0x40000000 && disposition==2);
 assert(has(p,L"DwarfOreToss"));
 files++;
 return (H)1;
}

int WriteFile(H f,const void*p,D n,D*w,void*o){
 (void)f;(void)o;
 assert((const unsigned char*)p>=payload_start && (const unsigned char*)p+n<=payload_end);
 if(!strcmp(mode,"write-fail"))return 0;
 bytes+=n;*w=n;return 1;
}

int CloseHandle(H f){(void)f;return 1;}

HRESULT SHGetFolderPathW(H hwnd,int csidl,H token,D flags,W*pszPath){
 (void)hwnd;(void)token;(void)flags;
 if(csidl==0x0010){copy(pszPath,L"C:\\Users\\Test Player\\Desktop");return 0;}
 if(csidl==0x0002){copy(pszPath,L"C:\\Users\\Test Player\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");return 0;}
 return -1;
}

static HRESULT mockPfSave(IPersistFile*This,const W*pszFileName,int fRemember){
 (void)This;(void)fRemember;
 if(has(pszFileName,L"Desktop\\Alpha Miner.lnk"))desktopShortcut++;
 if(has(pszFileName,L"Start Menu\\Programs\\Alpha Miner.lnk"))startMenuShortcut++;
 return 0;
}
static D mockPfRelease(IPersistFile*This){(void)This;return 0;}
static const IPersistFileVtbl mockPfVtbl = {.Release=mockPfRelease,.Save=mockPfSave};
static IPersistFile mockPf = {&mockPfVtbl};

static HRESULT mockSlQI(IShellLinkW*This,const GUID*riid,void**ppv){
 (void)This;
 assert(riid->Data1==0x0000010B);
 *ppv=&mockPf;
 return 0;
}
static D mockSlRelease(IShellLinkW*This){(void)This;return 0;}
static HRESULT mockSlSetPath(IShellLinkW*This,const W*pszFile){
 (void)This;
 assert(has(pszFile,L"chrome.exe"));
 return 0;
}
static HRESULT mockSlSetArgs(IShellLinkW*This,const W*pszArgs){
 (void)This;
 assert(has(pszArgs,L"--app=\"file:///C:/Users/Test Player/"));
 assert(has(pszArgs,L"/index.html\" --start-fullscreen"));
 assert(has(pszArgs,L"--user-data-dir=\"C:\\Users\\Test Player\\AppData\\Local\\DwarfOreToss\\ChromeProfile\""));
 return 0;
}
static HRESULT mockSlSetDir(IShellLinkW*This,const W*pszDir){
 (void)This;
 assert(has(pszDir,L"DwarfOreToss\\"));
 return 0;
}
static HRESULT mockSlSetIcon(IShellLinkW*This,const W*pszIcon,int iIcon){
 (void)This;
 assert(has(pszIcon,L"DwarfOreToss\\icon.ico") && iIcon==0);
 return 0;
}
static HRESULT mockSlSetDesc(IShellLinkW*This,const W*pszDesc){
 (void)This;
 assert(has(pszDesc,L"Chrome Standalone Desktop App"));
 return 0;
}
static HRESULT mockSlSetShow(IShellLinkW*This,int iShowCmd){
 (void)This;
 assert(iShowCmd==1);
 return 0;
}
static const IShellLinkWVtbl mockSlVtbl = {
 .QueryInterface=mockSlQI,
 .Release=mockSlRelease,
 .SetDescription=mockSlSetDesc,
 .SetWorkingDirectory=mockSlSetDir,
 .SetArguments=mockSlSetArgs,
 .SetShowCmd=mockSlSetShow,
 .SetIconLocation=mockSlSetIcon,
 .SetPath=mockSlSetPath
};
static IShellLinkW mockSl = {&mockSlVtbl};

HRESULT CoInitializeEx(void*pv,D coinit){(void)pv;assert(coinit==2);comInit=1;return 0;}
void CoUninitialize(void){assert(comInit==1);comInit=0;}
HRESULT CoCreateInstance(const GUID*rclsid,void*outer,D ctx,const GUID*riid,void**ppv){
 (void)outer;
 assert(rclsid->Data1==0x00021401 && ctx==1 && riid->Data1==0x000214F9);
 *ppv=&mockSl;
 return 0;
}

void ExitProcess(D code){
 if(!strcmp(mode,"write-fail")){
  assert(code==1&&files==1&&!launched&&!desktopShortcut);
 }else if(!strcmp(mode,"missing-chrome")){
  assert(code==1&&files==63&&!launched&&!desktopShortcut);
 }else if(!strcmp(mode,"extract")){
  assert(!code&&files==63&&dirs>10&&bytes>65000000&&!launched&&!desktopShortcut);
 }else if(!strcmp(mode,"install")){
  assert(!code&&files==63&&dirs>10&&bytes>65000000&&!launched&&desktopShortcut==1&&startMenuShortcut==1);
 }else{
  assert(!code&&files==63&&dirs>10&&bytes>65000000&&launched==1&&desktopShortcut==1&&startMenuShortcut==1);
 }
 printf("PASS launcher %s: %d filesWritten, %d dirsCreated, %llu bytes, desktopShortcut=%d, startMenuShortcut=%d, launch=%d\n",
        mode,files,dirs,bytes,desktopShortcut,startMenuShortcut,launched);
 exit(0);
}

int MessageBoxW(H h,const W*s,const W*t,D flags){
 (void)h;(void)t;(void)flags;
 assert(has(s,L"Google Chrome") || has(s,L"disk space") || has(s,L"Shortcuts have been added"));
 return 1;
}

W *GetCommandLineW(void){
 if(!strcmp(mode,"extract"))return L"game.exe --extract-only";
 if(!strcmp(mode,"install"))return L"game.exe --install-only";
 return L"game.exe";
}

int UrlCreateFromPathW(const W*p,W*out,D*n,D flags){
 (void)flags;
 copy(out,L"file:///");append(out,p);
 for(D i=0;out[i];i++)if(out[i]=='\\')out[i]='/';
 *n=length(out);return 0;
}

H ShellExecuteW(H h,const W*op,const W*exe,const W*params,const W*dir,int show){
 (void)h;(void)op;(void)dir;(void)show;
 assert(has(exe,L"chrome.exe"));
 assert(has(params,L"--app=\"file:///C:/Users/Test Player/"));
 assert(has(params,L"/index.html\" --start-fullscreen --no-first-run --no-default-browser-check"));
 assert(has(params,L"--user-data-dir=\"C:\\Users\\Test Player\\AppData\\Local\\DwarfOreToss\\ChromeProfile\""));
 launched=1;
 return (H)33;
}

int main(int argc,char**argv){assert(argc==2);mode=argv[1];entry();return 2;}
