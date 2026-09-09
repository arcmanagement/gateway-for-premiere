#ifndef MyAppVersion
  #error MyAppVersion must be provided with /DMyAppVersion=x.y.z
#endif
#ifndef StageDir
  #error StageDir must be provided with /DStageDir=path
#endif
#ifndef OutputDir
  #error OutputDir must be provided with /DOutputDir=path
#endif

[Setup]
AppId={{4E6D799A-93AB-4E9B-B875-280DB9847827}
AppName=Gateway for Premiere Companion
AppVersion={#MyAppVersion}
AppPublisher=ArcManagement Co., Ltd.
AppPublisherURL=https://github.com/arcmanagement/gateway-for-premiere
AppSupportURL=https://github.com/arcmanagement/gateway-for-premiere/issues
DefaultDirName={localappdata}\Programs\Gateway for Premiere
DefaultGroupName=Gateway for Premiere
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=Gateway-for-Premiere-{#MyAppVersion}-Windows
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
UninstallDisplayIcon={app}\runtime\x64\node.exe
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany=ArcManagement Co., Ltd.
VersionInfoDescription=Gateway for Premiere Companion Installer

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "{app}\bin\gateway-for-premiere.cmd"; Parameters: "daemon install"; StatusMsg: "Starting the local Gateway for Premiere broker..."; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{app}\bin\gateway-for-premiere.cmd"; Parameters: "daemon uninstall --confirm"; RunOnceId: "RemoveGatewayDaemon"; Flags: runhidden waituntilterminated skipifdoesntexist

[Code]
const
  EnvironmentKey = 'Environment';
  EnvironmentValue = 'Path';

function NormalizedPath(Value: String): String;
begin
  Result := Uppercase(RemoveBackslashUnlessRoot(Trim(Value)));
end;

function PathContains(Paths: String; Entry: String): Boolean;
var
  Remaining: String;
  Separator: Integer;
  Item: String;
begin
  Result := False;
  Remaining := Paths;
  while Remaining <> '' do
  begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then
    begin
      Item := Remaining;
      Remaining := '';
    end
    else
    begin
      Item := Copy(Remaining, 1, Separator - 1);
      Delete(Remaining, 1, Separator);
    end;
    if NormalizedPath(Item) = NormalizedPath(Entry) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

procedure AddToUserPath(Entry: String);
var
  Paths: String;
begin
  if not RegQueryStringValue(HKCU, EnvironmentKey, EnvironmentValue, Paths) then
    Paths := '';
  if PathContains(Paths, Entry) then
    Exit;
  if (Paths <> '') and (Copy(Paths, Length(Paths), 1) <> ';') then
    Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvironmentKey, EnvironmentValue, Paths + Entry);
end;

procedure RemoveFromUserPath(Entry: String);
var
  Paths: String;
  Remaining: String;
  Updated: String;
  Separator: Integer;
  Item: String;
begin
  if not RegQueryStringValue(HKCU, EnvironmentKey, EnvironmentValue, Paths) then
    Exit;
  Remaining := Paths;
  Updated := '';
  while Remaining <> '' do
  begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then
    begin
      Item := Remaining;
      Remaining := '';
    end
    else
    begin
      Item := Copy(Remaining, 1, Separator - 1);
      Delete(Remaining, 1, Separator);
    end;
    if (Item <> '') and (NormalizedPath(Item) <> NormalizedPath(Entry)) then
    begin
      if Updated <> '' then
        Updated := Updated + ';';
      Updated := Updated + Item;
    end;
  end;
  RegWriteExpandStringValue(HKCU, EnvironmentKey, EnvironmentValue, Updated);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddToUserPath(ExpandConstant('{app}\bin'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveFromUserPath(ExpandConstant('{app}\bin'));
end;
