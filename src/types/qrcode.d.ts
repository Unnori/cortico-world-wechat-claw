/**
 * `qrcode` 没有自带类型，而这里只用到「把一串文本渲染成 data URL」。
 * 只声明用到的那个成员，避免为一个函数引入整份第三方类型。
 */
declare module 'qrcode' {
  interface ToDataUrlOptions {
    margin?: number;
    width?: number;
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high' | 'L' | 'M' | 'Q' | 'H';
    type?: string;
    color?: { dark?: string; light?: string };
  }
  const QRCode: {
    toDataURL(text: string, options?: ToDataUrlOptions): Promise<string>;
  };
  export default QRCode;
}
