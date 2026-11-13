// Script que corre apenas llega el HTML de una app de área, antes de que
// React monte nada: registra el service worker y guarda el aviso de
// instalación de Chrome (beforeinstallprompt), que llega una sola vez y muy
// temprano. El botón "Instalar app" lo toma de window.__avisoInstalar y
// escucha "wio:instalable" para enterarse si llega después.

export const EVENTO_INSTALABLE = "wio:instalable";

export function CapturaInstalar({ scope }: { scope: string }) {
  const codigo = `(function(){try{
if("serviceWorker" in navigator){navigator.serviceWorker.register("/app-sw.js",{scope:${JSON.stringify(scope)}}).catch(function(){});}
window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__avisoInstalar=e;window.dispatchEvent(new Event(${JSON.stringify(EVENTO_INSTALABLE)}));});
window.addEventListener("appinstalled",function(){window.__avisoInstalar=null;window.__appInstalada=true;window.dispatchEvent(new Event(${JSON.stringify(EVENTO_INSTALABLE)}));});
}catch(_){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: codigo }} />;
}
